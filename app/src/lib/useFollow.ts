import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../context/AuthContext'

// UUID v1-v5 格式驗證
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUUID(v: string | null | undefined): boolean {
  if (!v) return false
  return UUID_RE.test(v)
}

export interface UseFollowReturn {
  followed: boolean
  notifySale: boolean
  notify30: boolean
  notify50: boolean
  notify70: boolean
  notifyPriceDrop: boolean
  loading: boolean
  toggling: boolean
  toggleFollow: () => Promise<{ ok: boolean; reason?: string }>
  setNotifyPriceDrop: (v: boolean) => Promise<{ ok: boolean; reason?: string }>
  setThresholds: (p: { sale?: boolean; t30?: boolean; t50?: boolean; t70?: boolean }) => Promise<{ ok: boolean; reason?: string }>
  refresh: () => Promise<void>
}

/**
 * 關注狀態 hook
 * - productId 必須為合法 UUID，否則視為未關注且不發請求
 * - 未登入時 followed=false，不發請求；toggle 回傳 not_logged_in
 */
export function useFollow(productId: string | null): UseFollowReturn {
  const { userId } = useAuth()
  const [followed, setFollowed] = useState(false)
  const [notifySale, _setNotifySale] = useState(true)
  const [notify30, _setNotify30] = useState(false)
  const [notify50, _setNotify50] = useState(false)
  const [notify70, _setNotify70] = useState(false)
  const [notifyPriceDrop, _setNotifyPriceDrop] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)

  const refresh = useCallback(async () => {
    if (!productId || !isValidUUID(productId)) {
      setFollowed(false)
      setLoading(false)
      return
    }
    if (!userId) {
      setFollowed(false)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('product_follows')
        .select('product_id, notify_price_drop, notify_sale, notify_30, notify_50, notify_70')
        .eq('user_id', userId)
        .eq('product_id', productId)
        .maybeSingle()

      if (error) {
        // 401/403 或其他錯誤 → 視為未關注，避免卡 loading
        if (error.code !== 'PGRST116') {
          console.warn('[useFollow] refresh error', error)
        }
        setFollowed(false)
      } else {
        setFollowed(!!data)
        const d = data as { notify_price_drop?: boolean; notify_sale?: boolean; notify_30?: boolean; notify_50?: boolean; notify_70?: boolean } | null
        _setNotifyPriceDrop(!!d?.notify_price_drop)
        _setNotifySale(d?.notify_sale ?? true)
        _setNotify30(!!d?.notify_30)
        _setNotify50(!!d?.notify_50)
        _setNotify70(!!d?.notify_70)
      }
    } catch (err) {
      console.warn('[useFollow] refresh exception', err)
      setFollowed(false)
    } finally {
      setLoading(false)
    }
  }, [productId, userId])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 外部關注資料同步，需等伺服器回應後才能更新
    void refresh()
  }, [refresh])

  const toggleFollow = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (!productId || !isValidUUID(productId)) {
      return { ok: false, reason: 'invalid_product_id' }
    }
    if (!userId) {
      return { ok: false, reason: 'not_logged_in' }
    }
    if (toggling) return { ok: false, reason: 'busy' }

    setToggling(true)
    const next = !followed

    // 樂觀更新
    setFollowed(next)

    try {
      if (next) {
        // 關注：insert，若已存在（23505）視為成功
        const { error } = await supabase
          .from('product_follows')
          .insert({ user_id: userId, product_id: productId })

        if (error) {
          if (error.code === '23505') {
            // unique constraint 衝突 → 已關注，視為成功
            return { ok: true }
          }
          throw error
        }
      } else {
        const { error } = await supabase
          .from('product_follows')
          .delete()
          .eq('user_id', userId)
          .eq('product_id', productId)

        if (error) throw error
      }
      return { ok: true }
    } catch (err: unknown) {
      // 回滾
      setFollowed(!next)
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code
      console.warn('[useFollow] toggle error', code, msg)
      // 401 未授權
      if (code === '401' || msg.includes('401') || msg.includes('JWT')) {
        return { ok: false, reason: 'unauthorized' }
      }
      return { ok: false, reason: 'server_error' }
    } finally {
      setToggling(false)
    }
  }, [productId, userId, followed, toggling])

  const setNotifyPriceDrop = useCallback(async (v: boolean): Promise<{ ok: boolean; reason?: string }> => {
    if (!productId || !isValidUUID(productId) || !userId) return { ok: false, reason: 'not_logged_in' }
    if (!followed) return { ok: false, reason: 'not_followed' }
    const prev = notifyPriceDrop
    _setNotifyPriceDrop(v)
    const { error } = await supabase.from('product_follows').update({ notify_price_drop: v }).eq('user_id', userId).eq('product_id', productId)
    if (error) { _setNotifyPriceDrop(prev); return { ok: false, reason: 'server_error' } }
    return { ok: true }
  }, [productId, userId, followed, notifyPriceDrop])

  const setThresholds = useCallback(async (p: { sale?: boolean; t30?: boolean; t50?: boolean; t70?: boolean }): Promise<{ ok: boolean; reason?: string }> => {
    if (!productId || !isValidUUID(productId) || !userId) return { ok: false, reason: 'not_logged_in' }
    if (!followed) return { ok: false, reason: 'not_followed' }
    const patch: Record<string, boolean> = {}
    if (p.sale !== undefined) patch.notify_sale = p.sale
    if (p.t30 !== undefined) patch.notify_30 = p.t30
    if (p.t50 !== undefined) patch.notify_50 = p.t50
    if (p.t70 !== undefined) patch.notify_70 = p.t70
    const prev = { sale: notifySale, t30: notify30, t50: notify50, t70: notify70 }
    if (p.sale !== undefined) _setNotifySale(p.sale)
    if (p.t30 !== undefined) _setNotify30(p.t30)
    if (p.t50 !== undefined) _setNotify50(p.t50)
    if (p.t70 !== undefined) _setNotify70(p.t70)
    const { error } = await supabase.from('product_follows').update(patch).eq('user_id', userId).eq('product_id', productId)
    if (error) { _setNotifySale(prev.sale); _setNotify30(prev.t30); _setNotify50(prev.t50); _setNotify70(prev.t70); return { ok: false, reason: 'server_error' } }
    return { ok: true }
  }, [productId, userId, followed, notifySale, notify30, notify50, notify70])

  return { followed, notifySale, notify30, notify50, notify70, notifyPriceDrop, loading, toggling, toggleFollow, setNotifyPriceDrop, setThresholds, refresh }
}
