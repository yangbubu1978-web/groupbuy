// ============================================================
// 共用：推播函式呼叫驗證（push-sale / push-price-drop 共用）
// 允許兩種身分二選一：
//   A) 排程密鑰：Authorization: Bearer <PUSH_CRON_SECRET>
//      給 pg_cron / Dashboard 排程用（無使用者身分）。
//   B) 管理員使用者 JWT：Authorization: Bearer <user access_token>
//      且該使用者在 public.admins 表內，給後台手動觸發用。
// 部署後必須在 Edge Function Secrets 設定 PUSH_CRON_SECRET，
// 排程呼叫時帶上同一把密鑰，否則一律 401/403。
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Deno: {
  env: { get(k: string): string | undefined };
};

export type PushAuthResult =
  | { ok: true; via: "cron_secret" | "admin_jwt" }
  | { ok: false; status: number; reason: string };

export async function authorizePush(
  req: Request,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
): Promise<PushAuthResult> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    return { ok: false, status: 401, reason: "unauthenticated" };
  }

  const secret = Deno.env.get("PUSH_CRON_SECRET") ?? "";
  if (secret && token === secret) {
    return { ok: true, via: "cron_secret" };
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !anon) {
    return { ok: false, status: 500, reason: "missing_supabase_env" };
  }

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) {
    return { ok: false, status: 401, reason: "unauthenticated" };
  }

  const { data: row } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!row) {
    return { ok: false, status: 403, reason: "forbidden" };
  }
  return { ok: true, via: "admin_jwt" };
}
