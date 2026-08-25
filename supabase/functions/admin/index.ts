// ============================================================
// Edge Function: admin — 管理員專用 API
// 動作（JSON body.action）:
//   createAuthUser  — 建立 auth.users 帳號（手機號碼當 email）
//   setAdmin        — 設定／移除管理員
//   resetPassword   — 重設客戶密碼
//   updateOrderStatus — 更新訂單狀態
// 部署: supabase functions deploy admin
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
    // service_role client（繞過 RLS，僅在驗證管理員後使用）
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return json({ ok: false, reason: 'unauthenticated' }, 401)
    }

    // 驗證呼叫者是否為管理員
    const { data: isAdminRow } = await admin
      .from('admins')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (!isAdminRow) {
      return json({ ok: false, reason: 'forbidden' }, 403)
    }

    const body = await req.json().catch(() => null)
    const action = body?.action

    // 手機號碼一律正規化後再使用（25. 手機格式）
    const normalizePhone = (raw: string): string => {
      let v = String(raw ?? '').replace(/\D/g, '')
      if (v.startsWith('886') && v.length >= 11) v = '0' + v.slice(3)
      return v
    }

    // 管理帳號（非手機）→ {account}@admin.groupbuy.local
    const normalizeAccountEmail = (raw: string): string => {
      const v = String(raw ?? '').trim().toLowerCase()
      return `${v}@admin.groupbuy.local`
    }

    switch (action) {
      // ---------- 建立 auth 帳號（方案 A：手機可空白，僅用名字建帳號） ----------
      case 'createAuthUser': {
        const rawPhone = body.phone ? normalizePhone(body.phone) : ''
        const hasPhone = /^09\d{8}$/.test(rawPhone)
        const { password, name } = body
        const pwd = String(password ?? '')
        if (!name || String(name).trim().length < 1 || !pwd || pwd.length < 6) {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        if (body.phone && String(body.phone).trim() !== '' && !hasPhone) {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        // email 策略：有手機 → phone@phone.groupbuy.local；無手機 → 名字轉 base64url@name.groupbuy.local
        let email: string
        let phoneMeta: string | null = null
        if (hasPhone) {
          email = `${rawPhone}@phone.groupbuy.local`
          phoneMeta = rawPhone
        } else {
          // 中文名轉 hex 當 local-part（避免中文直接當 email，Deno 無 unescape）
          let hex = ''
          try {
            const bytes = new TextEncoder().encode(String(name).trim())
            hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
            if (!hex) hex = 'user'
          } catch { hex = 'user' }
          const suffix = crypto.randomUUID().slice(0, 8)
          email = `n_${hex}_${suffix}@name.groupbuy.local`
        }
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password: pwd,
          email_confirm: true,
          user_metadata: { phone: phoneMeta ?? '', name: String(name).trim() },
        })
        if (error) {
          return json(
            { ok: false, reason: error.message.includes('already') ? 'exists' : error.message },
            409,
          )
        }
        return json({ ok: true, userId: data.user.id, email })
      }

      // ---------- 設定／移除管理員（by auth user_id，保留給腳本用） ----------
      case 'setAdminByUserId': {
        const { userId, isAdmin } = body
        if (!userId) return json({ ok: false, reason: 'bad_request' }, 400)
        if (isAdmin) {
          const { error } = await admin.from('admins').upsert({ user_id: userId })
          if (error) return json({ ok: false, reason: error.message }, 500)
        } else {
          const { error } = await admin.from('admins').delete().eq('user_id', userId)
          if (error) return json({ ok: false, reason: error.message }, 500)
        }
        return json({ ok: true })
      }

      // ---------- 重設密碼 ----------
      case 'resetPassword': {
        const phone = normalizePhone(body.phone)
        const { newPassword } = body
        if (!/^09\d{8}$/.test(phone) || !newPassword || String(newPassword).length < 6) {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        const email = `${phone}@phone.groupbuy.local`
        const { data: found } = await admin.auth.admin.listUsers()
        const target = found?.users?.find((u) => u.email === email)
        if (!target) return json({ ok: false, reason: 'not_found' }, 404)
        const { error } = await admin.auth.admin.updateUserById(target.id, {
          password: newPassword,
        })
        if (error) return json({ ok: false, reason: error.message }, 500)
        return json({ ok: true })
      }

      // ---------- 訂單狀態轉移（電商狀態機：合法流轉＋庫存回補） ----------
      case 'transitionOrder': {
        const { orderId, status, reason } = body
        if (!orderId || typeof status !== 'string') {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        const { data, error } = await admin
          .rpc('admin_transition_order', { p_order_id: orderId, p_next: status, p_reason: reason ?? null })
        if (error) return json({ ok: false, reason: error.message }, 500)
        const r = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string }
        if (!r?.ok) return json({ ok: false, reason: r?.reason ?? 'invalid_transition' }, 400)
        return json({ ok: true })
      }

      // ---------- 指派／撤銷管理員（總管理功能） ----------
      case 'setAdmin': {
        const { customerId, makeAdmin } = body
        if (!customerId || typeof makeAdmin !== 'boolean') {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        const { data: target } = await admin
          .from('customers')
          .select('id, auth_user_id, name, phone')
          .eq('id', customerId)
          .maybeSingle()
        if (!target?.auth_user_id) return json({ ok: false, reason: 'not_found' }, 404)

        // 防呆：不能把自己降級（避免最後一個管理員把自己鎖在外面）
        if (!makeAdmin && target.auth_user_id === userData.user.id) {
          return json({ ok: false, reason: 'cannot_demote_self' }, 400)
        }

        if (makeAdmin) {
          const { error } = await admin
            .from('admins')
            .upsert({ user_id: target.auth_user_id, note: `由後台指派（${target.name}）` })
          if (error) return json({ ok: false, reason: error.message }, 500)
        } else {
          const { error } = await admin
            .from('admins')
            .delete()
            .eq('user_id', target.auth_user_id)
          if (error) return json({ ok: false, reason: error.message }, 500)
        }
        return json({ ok: true })
      }

      // ---------- 刪除 auth 帳號（客戶刪除時一併清理） ----------
      case 'deleteAuthUser': {
        const phone = normalizePhone(body.phone)
        if (!/^09\d{8}$/.test(phone)) {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        const email1 = `${phone}@phone.groupbuy.local`
        const { data: found } = await admin.auth.admin.listUsers()
        const target = found?.users?.find((u) => u.email === email1 || u.phone === phone)
        if (!target) return json({ ok: false, reason: 'not_found' }, 404)
        const { error } = await admin.auth.admin.deleteUser(target.id)
        if (error) return json({ ok: false, reason: error.message }, 500)
        return json({ ok: true })
      }

      // ---------- 更新客戶登入資訊（改名／改手機／重設密碼，一次搞定） ----------
      case 'updateAuthUser': {
        const phone = normalizePhone(body.phone)
        const { newPhone, newName, newPassword } = body
        if (!/^09\d{8}$/.test(phone)) {
          return json({ ok: false, reason: 'bad_request' }, 400)
        }
        const email2 = `${phone}@phone.groupbuy.local`
        const { data: found2 } = await admin.auth.admin.listUsers()
        const target2 = found2?.users?.find((u) => u.email === email2 || u.phone === phone)
        if (!target2) return json({ ok: false, reason: 'not_found' }, 404)

        // 新手機也要過格式檢查（有填才更新）
        if (newPhone && !/^09\d{8}$/.test(normalizePhone(newPhone))) {
          return json({ ok: false, reason: 'invalid_new_phone' }, 400)
        }

        const update: Record<string, unknown> = {}
        if (newPhone) {
          const np = normalizePhone(newPhone)
          update.email = `${np}@phone.groupbuy.local`
          update.user_metadata = { ...(target2.user_metadata ?? {}), phone: np }
        }
        if (newName) update.user_metadata = { ...(update.user_metadata ?? {}), name: newName }
        if (newPassword) {
          if (String(newPassword).length < 6) {
            return json({ ok: false, reason: 'weak_password' }, 400)
          }
          update.password = newPassword
        }
        if (Object.keys(update).length === 0) return json({ ok: true })

        const { error } = await admin.auth.admin.updateUserById(target2.id, update)
        if (error) {
          return json(
            { ok: false, reason: error.message.includes('already') ? 'phone_exists' : error.message },
            409,
          )
        }
        return json({ ok: true, newPhone: update.email ? String(update.email).split('@')[0] : undefined })
      }

      default:
        return json({ ok: false, reason: 'unknown_action' }, 400)
    }
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
