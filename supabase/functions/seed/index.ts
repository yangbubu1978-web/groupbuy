// ============================================================
// Edge Function: seed — 建立示範 auth 帳號（對應 schema.sql 種子客戶）
// 部署後以 service role key 呼叫一次即可：
//   curl -X POST "<FUNCTION_URL>" \
//     -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
//     -H "Content-Type: application/json" -d '{}'
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

const DEMO_USERS = [
  { phone: '0975389197', name: '王小明', password: 'demo1234' },
  { phone: '0912000002', name: '李小華', password: 'demo1234' },
  { phone: '0912000003', name: '陳大同', password: 'demo1234' },
]

Deno.serve(async () => {
  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const results: Array<Record<string, unknown>> = []
    for (const u of DEMO_USERS) {
      const email = `${u.phone}@phone.groupbuy.local`
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: u.password,
        email_confirm: true,
        user_metadata: { phone: u.phone, name: u.name },
      })
      if (error && !error.message.includes('already')) {
        results.push({ phone: u.phone, ok: false, error: error.message })
        continue
      }
      // 將 auth user 綁定到 customers 白名單
      let userId = data?.user?.id ?? undefined
      if (!userId) {
        const { data: found } = await admin.auth.admin.listUsers()
        userId = found?.users?.find((x) => x.email === email)?.id
      }
      if (userId) {
        await admin.from('customers')
          .update({ auth_user_id: userId })
          .eq('phone', u.phone)
      }
      results.push({ phone: u.phone, ok: true })
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (_e) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
