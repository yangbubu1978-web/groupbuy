// ============================================================
// Edge Function: purchase — 搶購下單
// 流程: 驗證 JWT → 呼叫 purchase_product() RPC（單一 SQL 交易）
//       Server 端計價 + 原子扣庫存 + 建立訂單
// 部署: supabase functions deploy purchase
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
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
      return json({ ok: false, reason: 'unauthenticated' }, 401)
    }

    const body = await req.json().catch(() => null)
    const productId: string | undefined = body?.productId
    const quantity: number = Number(body?.quantity ?? 1)
    if (!productId || !Number.isInteger(quantity) || quantity < 1) {
      return json({ ok: false, reason: 'bad_request' }, 400)
    }

    // 核心搶購：資料庫函式內完成「驗證→計價→扣庫存→建庫存→建單」單一交易
    const { data, error } = await supabase.rpc('purchase_product', {
      p_product_id: productId,
      p_quantity: quantity,
    })
    if (error) {
      return json({ ok: false, reason: 'server_error' }, 500)
    }
    // FOMO：檔次已超時自動結束（DB 端判定）
    if (data && !data.ok && data.reason === 'offer_ended') {
      return json({ ok: false, reason: 'offer_ended' }, 410)
    }
    return json(data, data?.ok ? 200 : 409)
  } catch (_e) {
    return json({ ok: false, reason: 'server_error' }, 500)
  }
})

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
