import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Customer } from '../lib/types'

interface AuthState {
  loading: boolean
  userId: string | null
  customer: Customer | null
  isAdmin: boolean
  signIn: (phone: string, password: string) => Promise<{ ok: boolean; reason?: string }>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  loading: true,
  userId: null,
  customer: null,
  isAdmin: false,
  signIn: async () => ({ ok: false }),
  signOut: async () => {},
  refresh: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  // 載入目前 session 與白名單資料
  const refresh = async () => {
    const { data: sess } = await supabase.auth.getSession()
    const uid = sess.session?.user?.id ?? null
    setUserId(uid)
    if (uid) {
      const { data: c } = await supabase
        .from('customers')
        .select('*')
        .eq('auth_user_id', uid)
        .maybeSingle()
      setCustomer((c as Customer) ?? null)
      const { data: a } = await supabase
        .from('admins')
        .select('user_id')
        .eq('user_id', uid)
        .maybeSingle()
      setIsAdmin(!!a)
    } else {
      setCustomer(null)
      setIsAdmin(false)
    }
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 登入狀態需跟外部驗證系統同步，初次進入與狀態變化時更新
    refresh()
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      refresh()
    })
    return () => { sub.subscription.unsubscribe() }
  }, [])

  const signIn = async (phone: string, password: string) => {
    // 正規化：去分隔符、+886 國碼 → 統一 09XXXXXXXX（25. 手機格式）
    let normalized = phone.replace(/[\s-]/g, '')
    if (normalized.startsWith('+886')) normalized = '0' + normalized.slice(4)
    else if (normalized.startsWith('886') && normalized.length >= 11) {
      normalized = '0' + normalized.slice(3)
    }

    // 三軌登入（方案 A 雙軌共用 RPC）：
    //   1) 中文姓名 → lookup_login_by_name → 回傳 auth email
    //   2) 手機會員：09XXXXXXXX → lookup_login_by_phone → 回傳 auth email（支援手機後補的 name-based 帳號）
    //   3) 管理帳號（admin 等）：非手機格式的英數帳號 → {account}@admin.groupbuy.local
    let loginEmail: string
    if (/^09\d{8}$/.test(normalized)) {
      const { data: lookup, error: lookupErr } = await supabase
        .rpc('lookup_login_by_phone', { p_phone: normalized })
      const res = (lookup ?? {}) as { ok?: boolean; email?: string; reason?: string }
      if (lookupErr || !res.ok || !res.email) {
        // 兼容舊資料：若 RPC 找不到，嘗試直接用 phone email（舊帳號可能還沒建 phone 索引）
        // 但新制下應回 phone_not_found
        if (res.reason === 'phone_not_found') return { ok: false, reason: 'phone_not_found' }
        return { ok: false, reason: 'phone_not_found' }
      }
      loginEmail = res.email
    } else if (/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(normalized)) {
      loginEmail = `${normalized.toLowerCase()}@admin.groupbuy.local`
    } else if (/^[\u4e00-\u9fff·‧]{2,12}$/.test(normalized)) {
      // 中文姓名：先向伺服端查詢對應的登入 email（不暴露手機等 PII）
      const { data: lookup, error: lookupErr } = await supabase
        .rpc('lookup_login_by_name', { p_name: normalized })
      const res = (lookup ?? {}) as { ok?: boolean; email?: string; reason?: string }
      if (lookupErr || !res.ok || !res.email) {
        return { ok: false, reason: 'name_not_found' }
      }
      loginEmail = res.email
    } else {
      return { ok: false, reason: 'invalid_phone' }
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password,
    })
    if (error) {
      return { ok: false, reason: 'bad_credentials' }
    }
    await refresh()

    // 白名單與狀態檢查：非 active 一律登出拒絕
    const { data: sess } = await supabase.auth.getSession()
    const uid = sess.session?.user?.id ?? null
    if (!uid) return { ok: false, reason: 'bad_credentials' }
    const { data: c } = await supabase
      .from('customers')
      .select('*')
      .eq('auth_user_id', uid)
      .maybeSingle()
    if (!c) {
      await supabase.auth.signOut()
      return { ok: false, reason: 'not_whitelisted' }
    }
    if ((c as Customer).status !== 'active') {
      await supabase.auth.signOut()
      return { ok: false, reason: `account_${(c as Customer).status}` }
    }
    return { ok: true }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUserId(null)
    setCustomer(null)
    setIsAdmin(false)
  }

  return (
    <AuthContext.Provider value={{ loading, userId, customer, isAdmin, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
