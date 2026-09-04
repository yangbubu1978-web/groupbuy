// ============================================================
// Edge Function: purchase — 搶購下單
// 流程: 驗證 JWT → 呼叫 purchase_product() RPC（單一 SQL 交易）
//       Server 端計價 + 原子扣庫存 + 建立訂單
// 部署: supabase functions deploy purchase
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { rateLimit, rateLimitKeyFrom } from '../_shared/rate_limit.ts'
import { handleCors, json } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    // 驗證使用者
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user) {
      return json({ ok: false, reason: 'unauthenticated' }, req, 401)
    }

    const body = await req.json().catch(() => null)
    const productId: string | undefined = body?.productId
    const quantity: number = Number(body?.quantity ?? 1)
    if (!productId || !Number.isInteger(quantity) || quantity < 1) {
      return json({ ok: false, reason: 'bad_request' }, req, 400)
    }

    // 限流：每個使用者每分鐘最多 12 次下單意圖（正常人按不出這麼多次）
    const uid = userData.user.id
    const rl = rateLimit(rateLimitKeyFrom(uid, req), 12, 60)
    if (!rl.allowed) {
      return json(
        { ok: false, reason: 'rate_limited', retry_after: rl.retryAfterSeconds },
        429,
        { 'Retry-After': String(rl.retryAfterSeconds) },
      )
    }

    // 唯一交易路徑：先建立 60 秒鎖價，再以同一 Reservation 結帳。
    const { data: reservation, error: reserveError } = await supabase.rpc('reserve_product', {
      p_product_id: productId,
      p_quantity: quantity,
    })
    if (reserveError) {
      return json({ ok: false, reason: 'server_error' }, req, 500)
    }
    if (!reservation?.ok) {
      return json(reservation, req, reservation?.reason === 'offer_ended' ? 410 : 409)
    }

    const { data, error } = await supabase.rpc('checkout_reservation', {
      p_reservation_id: reservation.reservation_id,
    })
    if (error) {
      // 不在 Edge Function 內自行補庫存；DB transaction / cleanup 負責一致性。
      return json({ ok: false, reason: 'server_error' }, req, 500)
    }
    return json(data, req, data?.ok ? 200 : 409)
  } catch (_e) {
    return json({ ok: false, reason: 'server_error' }, req, 500)
  }
})