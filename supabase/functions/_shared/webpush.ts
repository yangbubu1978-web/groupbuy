// _shared/webpush.ts — Deno Web Push helpers (VAPID + AES128GCM stub)
// 真實發送需完成 RFC8291 加密；此雛形先做 VAPID JWT + fetch，
// 若需完整加密可替換 encryptPayload() 為實際 ECDH 實作或引入 npm:web-push

function b64urlEncode(buf: Uint8Array | ArrayBuffer): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// 將 raw base64url VAPID key (65 bytes uncompressed EC point) 轉 JWK
function vapidKeysToJwk(publicKey: string, privateKey: string) {
  const pub = b64urlDecode(publicKey);
  // publicKey 應為 65 bytes: 0x04 + x(32) + y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("invalid VAPID_PUBLIC_KEY");
  const x = b64urlEncode(pub.slice(1, 33));
  const y = b64urlEncode(pub.slice(33, 65));
  const d = privateKey.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  // privateKey 可能是 base64url(32 bytes) 或 raw; 統一當作 base64url
  // 若長度不是 43/44，嘗試當 base64 解
  let dNorm = d;
  try {
    const raw = b64urlDecode(d);
    if (raw.length === 32) dNorm = b64urlEncode(raw);
  } catch { /* keep as is */ }
  return { x, y, d: dNorm };
}

async function buildVapidAuthHeader(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })),
  );
  const unsigned = `${header}.${payload}`;
  const jwk = vapidKeysToJwk(publicKey, privateKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  // ECDSA sig is ASN.1 DER -> need raw r||s (64 bytes)
  const raw = derToRaw(new Uint8Array(sigBuf));
  const sig = b64urlEncode(raw);
  return `vapid t=${header}.${payload}.${sig}, k=${publicKey}`;
}

function derToRaw(der: Uint8Array): Uint8Array {
  // 若已是 64 bytes 直接回傳
  if (der.length === 64) return der;
  // 簡易 DER 解析: 0x30 len 0x02 lenR r 0x02 lenS s
  try {
    let o = 2; // skip 0x30 len
    if (der[o] !== 0x02) return der.slice(0, 64);
    const lenR = der[o + 1];
    let r = der.slice(o + 2, o + 2 + lenR);
    o = o + 2 + lenR;
    if (der[o] !== 0x02) return der.slice(0, 64);
    const lenS = der[o + 1];
    let s = der.slice(o + 2, o + 2 + lenS);
    // 去前導 0x00, 左補零至 32 bytes
    if (r.length > 32) r = r.slice(r.length - 32);
    if (s.length > 32) s = s.slice(s.length - 32);
    const out = new Uint8Array(64);
    out.set(r, 32 - r.length);
    out.set(s, 64 - s.length);
    return out;
  } catch {
    return der.slice(0, 64);
  }
}

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
 * 發送單一 Web Push
 * - 雛形：僅帶 VAPID 頭 + JSON payload (不做完整 aes128gcm 加密)
 *   真實瀏覽器推播需對 payload 做 RFC8291 加密；若 endpoint 要求加密而未加密，
 *   推播服務會回 400，此時應補上加密或改為無 payload 觸發 + SW 自行 fetch。
 * - 回傳 gone=true 表示訂閱已失效，呼叫端應將 push_subscriptions.is_valid=false
 */
export async function sendPush(
  sub: PushSubscriptionRow,
  payload: unknown,
  vapid: VapidConfig,
): Promise<SendResult> {
  const body = JSON.stringify(payload);
  // 嘗試帶 VAPID Authorization
  let vapidAuth = "";
  try {
    vapidAuth = await buildVapidAuthHeader(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  } catch (e) {
    return { ok: false, status: 0, error: `vapid_error:${e instanceof Error ? e.message : String(e)}` };
  }

  // 注意：完整實作應對 body 做 aes128gcm 加密 (需 p256dh/auth + ECDH)。
  // 雛形先以明文 JSON 發送；若推播服務拒絕，會回 400/413，視為發送失敗但不標 gone。
  const headers: Record<string, string> = {
    TTL: "86400",
    Authorization: vapidAuth,
    "Content-Type": "application/json",
    Urgency: "high",
  };

  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers,
      body,
    });
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true, error: `gone:${res.status}` };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: txt.slice(0, 500) || `http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
