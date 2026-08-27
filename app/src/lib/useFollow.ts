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
  loading: boolean
  toggling: boolean
  toggleFollow: () => Promise<{ ok: boolean; reason?: string }>
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
        .select('product_id')
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
      }
    } catch (err) {
      console.warn('[useFollow] refresh exception', err)
      setFollowed(false)
    } finally {
      setLoading(false)
    }
  }, [productId, userId])

  useEffect(() => {
    refresh()
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

  return { followed, loading, toggling, toggleFollow, refresh }
}
