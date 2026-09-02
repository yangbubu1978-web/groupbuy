// ============================================================
// Edge Function: push-price-drop — 降價 30/50/70% 三階段推播
// 條件: stock>0 且 (original_price - current_price)/original_price >=0.3
//       且有人關注 (product_follows) 且 notify_price_drop 未關閉
// 去重鍵: `${user_id}:${product_id}:price_drop_30|50|70`，依 price_drop_mode (once/all) 決定
// 標題: "📉 你關注的商品已降 30%！"
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCors, json } from "../_shared/cors.ts";
import { getVapidConfig, sendPush } from "../_shared/webpush.ts";

declare const Deno: { env: { get(k: string): string | undefined } };

// JS 版 compute_current_price 鏡像（與 migration 20260822 隨機降價版一致）
// 若 price_decrease_max 為空則視為固定降幅
function computeCurrentPrice(p: {
  original_price: number;
  minimum_price: number;
  price_interval_seconds: number;
  price_decrease: number;
  price_decrease_max?: number | null;
  sale_start_at: string | null;
}): number {
  const start = p.sale_start_at ? new Date(p.sale_start_at) : null;
  if (!start) return Number(p.original_price);
  const elapsed = Math.max(0, (Date.now() - start.getTime()) / 1000);
  const interval = Math.max(1, p.price_interval_seconds);
  const steps = Math.floor(elapsed / interval);
  if (steps <= 0) return Number(p.original_price);
  const lo = Math.max(0, Math.round(Number(p.price_decrease)));
  const hi = p.price_decrease_max != null ? Math.max(lo, Math.round(Number(p.price_decrease_max))) : lo;
  if (lo === 0 && hi === 0) return Number(p.original_price);
  const vMin = Math.min(Number(p.minimum_price), Number(p.original_price));
  const range = Number(p.original_price) - vMin;
  if (range <= 0) return Number(p.original_price);
  // 雛形：用平均降幅近似隨機總和（避免逐期隨機需固定 seed）
  const avg = (lo + hi) / 2;
  const acc = Math.min(range, steps * avg);
  return Math.round(Math.max(vMin, Number(p.original_price) - acc) * 100) / 100;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const vapid = getVapidConfig();
  if (!vapid) return json({ ok: false, reason: "missing_vapid_keys" }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return json({ ok: false, reason: "missing_supabase_env" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) 拉候選商品（stock>0 + active + 有原價），在 JS 端算是否已達 30/50/70% 門檻
  const { data: products, error: prodErr } = await admin
    .from("products")
    .select(
      "id, name, image_url, campaign_id, stock, original_price, minimum_price, price_interval_seconds, price_decrease, price_decrease_max, sale_start_at, status",
    )
    .eq("status", "active")
    .gt("stock", 0);

  if (prodErr) return json({ ok: false, reason: "query_products_failed", detail: prodErr.message }, 500);
  if (!products || products.length === 0) return json({ ok: true, sent: 0, products: 0 });

  const candidates = (products as unknown as Array<{
    id: string;
    name: string;
    image_url: string | null;
    campaign_id: string;
    stock: number;
    original_price: number;
    minimum_price: number;
    price_interval_seconds: number;
    price_decrease: number;
    price_decrease_max: number | null;
    sale_start_at: string | null;
  }>).filter((p) => {
    if (!p.original_price || Number(p.original_price) <= 0) return false;
    const cur = computeCurrentPrice(p);
    const drop = (Number(p.original_price) - cur) / Number(p.original_price);
    return drop >= 0.3;
  });

  if (candidates.length === 0) return json({ ok: true, sent: 0, products: products.length, candidates: 0 });

  let sent = 0;
  let skipped = 0;
  let gone = 0;
  const errors: string[] = [];

  // 三階段門檻
  const THRESHOLDS = [30, 50, 70] as const;

  for (const p of candidates) {
    const curPrice = computeCurrentPrice(p);
    const dropPct = Math.floor(((Number(p.original_price) - curPrice) / Number(p.original_price)) * 100);
    // 此商品已達哪幾階段（例如 drop 55% => [30,50]）
    const reached = THRESHOLDS.filter((th) => dropPct >= th);
    if (reached.length === 0) continue;

    // 2) 查關注者；若表有 notify_price_drop 欄位則過濾，否則全量（相容舊 schema）
    // 同時讀 price_drop_mode（once=僅30, all=三階段）
    let follows: Array<{ user_id: string; notify_30?: boolean; notify_50?: boolean; notify_70?: boolean }> | null = null;
    {
      const r1 = await admin.from("product_follows").select("user_id").eq("product_id", p.id);
      // 嘗試第二查詢：若欄位存在則過濾 notify_price_drop=true
      // 先用全量，再在 JS 端過濾（若欄位不存在，select 不會報錯；filter 在 JS）
      // 為了不依賴欄位存在性，這裡先全量拉回，若有該欄位則額外查一次
      if (r1.error) {
        errors.push(`follows:${p.id}:${r1.error.message}`);
        continue;
      }
      follows = r1.data as Array<{ user_id: string }>;
      // 探測 notify_price_drop 欄位是否存在：嘗試帶該欄位查詢，失敗則忽略
      const probe = await admin
        .from("product_follows")
        .select("user_id, notify_sale, notify_30, notify_50, notify_70")
        .eq("product_id", p.id)
        .limit(1);
      if (!probe.error && probe.data && probe.data.length > 0 && "notify_price_drop" in (probe.data[0] as Record<string, unknown>)) {
        const filtered = await admin
          .from("product_follows")
          .select("user_id, notify_30, notify_50, notify_70")
          .eq("product_id", p.id)
          .eq("notify_price_drop", true);
        if (!filtered.error && filtered.data) follows = filtered.data as Array<{ user_id: string; notify_30?: boolean; notify_50?: boolean; notify_70?: boolean }> ;
      }
    }
    if (!follows || follows.length === 0) continue;

    for (const f of follows) {
      const userId = f.user_id;
      const thresholds: Record<number, boolean> = { 30: !!(f as any).notify_30, 50: !!(f as any).notify_50, 70: !!(f as any).notify_70 };
      const thresholdsForUser = reached.filter(th => thresholds[th]);
      for (const th of thresholdsForUser) {
        const dedupKey = `${userId}:${p.id}:price_drop_${th}`;

      const { data: existed } = await admin
        .from("notification_logs")
        .select("id")
        .eq("dedup_key", dedupKey)
        .maybeSingle();
      if (existed) {
        skipped++;
        continue;
      }

      const { data: subs, error: sErr } = await admin
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth")
        .eq("user_id", userId)
        .eq("is_valid", true);
      if (sErr) {
        errors.push(`subs:${userId}:${sErr.message}`);
        continue;
      }
      if (!subs || subs.length === 0) {
        await admin.from("notification_logs").insert({
          user_id: userId,
          product_id: p.id,
          type: `price_drop_${th}`,
          dedup_key: dedupKey,
          push_success: false,
        });
        skipped++;
        continue;
      }

      const payload = {
        title: `📉 你關注的商品已降 ${th}%！`, 
        body: `${p.name} 現價 $${curPrice}（原價 $${p.original_price} 已降 ${th}%），庫存剩 ${p.stock} 件`, 
        icon: p.image_url ?? undefined,
        data: { product_id: p.id, campaign_id: p.campaign_id, url: `/product/${p.id}`, type: `price_drop_${th}`, threshold: th, current_price: curPrice },
      };

      let anyOk = false;
      for (const sub of subs) {
        const r = await sendPush(sub as { endpoint: string; p256dh: string; auth: string }, payload, vapid);
        if (r.ok) anyOk = true;
        if (r.gone) {
          gone++;
          await admin.from("push_subscriptions").update({ is_valid: false }).eq("endpoint", sub.endpoint);
        }
        if (!r.ok && !r.gone) errors.push(`push:${userId}:${r.status}:${r.error?.slice(0, 100)}`);
      }

      const { error: logErr } = await admin.from("notification_logs").insert({
        user_id: userId,
        product_id: p.id,
        type: `price_drop_${th}`,
        dedup_key: dedupKey,
        push_success: anyOk,
      });
      if (logErr && (logErr as { code?: string }).code !== "23505" && !logErr.message.includes("duplicate")) {
        errors.push(`log:${dedupKey}:${logErr.message}`);
      }
        if (anyOk) sent++;
        else skipped++;
      }
    }
  }

  return json({ ok: true, sent, skipped, gone, products: products.length, candidates: candidates.length, errors: errors.slice(0, 20) });
});
