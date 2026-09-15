// _shared/webpush.ts — Deno Web Push（真實 RFC8291 aes128gcm 加密）
//
// 2026-09-15 改版：原為「雛形」——只帶 VAPID 頭 + 明文 JSON，未做負載加密，
// 真實瀏覽器會拒絕（推播服務回 400 或手機只收到空白通知）。
// 現改用業界標準 npm:web-push（內部實作 RFC8291 aes128gcm + RFC8292 VAPID），
// 介面（getVapidConfig / sendPush / 型別）刻意保持一致，呼叫端不需修改。
//
// 環境變數：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（base64url）/ VAPID_SUBJECT
// ⚠️ 回傳 gone=true 表示訂閱已失效（404/410），呼叫端應把 push_subscriptions.is_valid 設 false。
// Deno 執行期才有全域 Deno 物件（本倉 TS 設定不含 deno 型別，故補最小 shim）
declare const Deno: { env: { get(k: string): string | undefined } };

// @ts-expect-error npm: 指定子只有 Deno 認得；Vite 的 TS 設定解析不到，屬預期
import webpush from "npm:web-push@3.6.7";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto:xxx 或 https://
}

export function getVapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@groupbuy.local";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  gone?: boolean; // 404/410 需要標 is_valid=false
  error?: string;
}

/**
 * 發送單一 Web Push（RFC8291 加密）
 * - 成功回 { ok:true, status:201 }
 * - 訂閱失效回 { ok:false, status:404|410, gone:true }
 * - 其他失敗回 { ok:false, status:<http>, error:<推播服務回應> }
 */
export async function sendPush(
  sub: PushSubscriptionRow,
  payload: unknown,
  vapid: VapidConfig,
): Promise<SendResult> {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    return { ok: false, status: 0, error: `payload_error:${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  } catch (e) {
    return { ok: false, status: 0, error: `vapid_error:${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { TTL: 86400, urgency: "high" },
    );
    return { ok: true, status: (res && typeof res.statusCode === "number") ? res.statusCode : 201 };
  } catch (e) {
    // web-push 失敗時丟 WebPushError：{ statusCode, body, message }
    const err = e as { statusCode?: number; body?: string; message?: string };
    const status = typeof err?.statusCode === "number" ? err.statusCode : 0;
    if (status === 404 || status === 410) {
      return { ok: false, status, gone: true, error: `gone:${status}` };
    }
    const detail = (err?.body ?? err?.message ?? String(e)).slice(0, 500);
    return { ok: false, status, error: detail || `http_${status}` };
  }
}
