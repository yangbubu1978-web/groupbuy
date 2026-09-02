// ============================================================
// Edge Function: push-sale — 開賣推播（每 2 分鐘掃一次，由 cron 觸發）
// 去重鍵: `${user_id}:${product_id}:${sale_start_at.toISOString()}`
// 觸發: supabase cron 或手動 POST；內部用 service_role 繞過 RLS
// 環境: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, handleCors, json } from "../_shared/cors.ts";
import { getVapidConfig, sendPush } from "../_shared/webpush.ts";

// Deno global for edge runtime
declare const Deno: { env: { get(k: string): string | undefined } };

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // 僅允許 POST/GET（cron 用 POST）
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const vapid = getVapidConfig();
  if (!vapid) {
    return json({ ok: false, reason: "missing_vapid_keys" }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, reason: "missing_supabase_env" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000);

  // 1) 找出 2 分鐘內剛開賣的商品
  const { data: products, error: prodErr } = await admin
    .from("products")
    .select("id, name, image_url, sale_start_at, campaign_id")
    .lte("sale_start_at", now.toISOString())
    .gt("sale_start_at", twoMinAgo.toISOString())
    .eq("status", "active");

  if (prodErr) {
    return json({ ok: false, reason: "query_products_failed", detail: prodErr.message }, 500);
  }
  if (!products || products.length === 0) {
    return json({ ok: true, sent: 0, products: 0, reason: "no_new_sales" });
  }

  let totalSent = 0;
  let totalSkipped = 0;
  let totalGone = 0;
  const errors: string[] = [];

  for (const p of products) {
    const saleIso = p.sale_start_at as string;
    // 2) 查關注此商品的用戶
    const { data: follows, error: fErr } = await admin
      .from("product_follows")
      .select("user_id")
      .eq("product_id", p.id);
    if (fErr) {
      errors.push(`follows:${p.id}:${fErr.message}`);
      continue;
    }
    if (!follows || follows.length === 0) continue;

    for (const f of follows) {
      const userId = (f as { user_id: string }).user_id;
      const dedupKey = `${userId}:${p.id}:${saleIso}`;

      // 3) 去重：已發過就跳過
      const { data: existed } = await admin
        .from("notification_logs")
        .select("id")
        .eq("dedup_key", dedupKey)
        .maybeSingle();
      if (existed) {
        totalSkipped++;
        continue;
      }

      // 4) 查有效訂閱
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
        // 無訂閱仍寫 log 避免重複空轉（標 push_success=false）
        await admin.from("notification_logs").insert({
          user_id: userId,
          product_id: p.id,
          type: "sale_start",
          dedup_key: dedupKey,
          push_success: false,
        });
        totalSkipped++;
        continue;
      }

      const payload = {
        title: "🔔 你關注的商品開賣了！",
        body: `${p.name} 已經開賣，手刀搶購！`,
        icon: p.image_url ?? undefined,
        data: { product_id: p.id, campaign_id: p.campaign_id, url: `/product/${p.id}`, type: "sale_start" },
      };

      let anyOk = false;
      for (const sub of subs) {
        const r = await sendPush(
          sub as { endpoint: string; p256dh: string; auth: string },
          payload,
          vapid,
        );
        if (r.ok) anyOk = true;
        if (r.gone) {
          totalGone++;
          await admin.from("push_subscriptions").update({ is_valid: false }).eq("endpoint", sub.endpoint);
        }
        if (!r.ok && !r.gone) errors.push(`push:${userId}:${r.status}:${r.error?.slice(0, 100)}`);
      }

      // 5) 寫去重日誌
      const { error: logErr } = await admin.from("notification_logs").insert({
        user_id: userId,
        product_id: p.id,
        type: "sale_start",
        dedup_key: dedupKey,
        push_success: anyOk,
      });
      if (logErr) {
        // 23505 unique 衝突表示併發已寫入，忽略
        if (!logErr.message.includes("duplicate") && (logErr as { code?: string }).code !== "23505") {
          errors.push(`log:${dedupKey}:${logErr.message}`);
        } else {
          totalSkipped++;
          continue;
        }
      }
      if (anyOk) totalSent++;
      else totalSkipped++;
    }
  }

  return json(
    { ok: true, sent: totalSent, skipped: totalSkipped, gone: totalGone, products: products.length, errors: errors.slice(0, 20) },
    200,
  );
});
