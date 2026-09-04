// ============================================================
// 共用：Edge Function CORS 白名單
// 只允許自家網域跨站呼叫；非白名單一律不給 Access-Control-Allow-Origin，
// 瀏覽器會依同源政策擋下回應（curl/伺服器端直呼不受 CORS 影響，
// 但函式本身另有身分驗證，此層僅收斂「惡意網站借訪客瀏覽器觸發」的攻擊面）。
// 需要放行新網域時加進 ALLOWED_ORIGINS 即可。
// ============================================================

export const ALLOWED_ORIGINS: string[] = [
  "https://store-mvp.vercel.app",
  "https://store-mvp-dynamosan-3784s-projects.vercel.app",
  // 本機開發（Vite 預設埠）
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function originFor(req: Request): string {
  const origin = req.headers.get("Origin") ?? "";
  // 無 Origin（同源呼叫 / curl / cron）→ 不需要跨站標頭
  if (!origin) return "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Vercel preview 網址（store-<hash>-dynamosan-3784s-projects.vercel.app）放行
  if (/^https:\/\/store-[a-z0-9]+-dynamosan-3784s-projects\.vercel\.app$/.test(origin)) return origin;
  return "";
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = originFor(req);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

/** OPTIONS 預檢用；非白名單回 204 但不給跨站標頭（瀏覽器會擋）。 */
export function handleCors(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const headers = corsHeadersFor(req);
  return new Response("ok", { status: 204, headers });
}

export function json(
  payload: unknown,
  req: Request,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json", ...extraHeaders },
  });
}
