import { supabase } from './supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function arrayBufferToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return ''
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function isSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
}

/**
 * 註冊瀏覽器 Push 訂閱並寫入 Supabase push_subscriptions
 * - 檢查 serviceWorker / PushManager 支援
 * - 檢查 / 請求 Notification 權限
 * - 取得 SW registration → pushManager.subscribe
 * - upsert 到 Supabase（endpoint 唯一鍵衝突時更新）
 * @returns PushSubscription 或 null（不支援 / 被拒 / 失敗）
 */
export async function registerPushSubscription(): Promise<PushSubscription | null> {
  if (!isSupported()) {
    console.warn('[push] 此瀏覽器不支援 Push')
    return null
  }

  if (!VAPID_PUBLIC_KEY) {
    console.warn('[push] 尚未設定 VITE_VAPID_PUBLIC_KEY，無法訂閱')
    return null
  }

  // 1) 權限檢查
  if (Notification.permission === 'denied') {
    console.warn('[push] 通知權限已被拒絕，請至瀏覽器設定開啟')
    return null
  }

  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      console.warn('[push] 使用者未授權通知，permission =', perm)
      return null
    }
  }

  // 2) 取得 Service Worker registration
  let registration: ServiceWorkerRegistration
  try {
    registration = await navigator.serviceWorker.ready
  } catch (err) {
    console.warn('[push] 無法取得 ServiceWorker registration', err)
    return null
  }

  // 3) 取得或建立 PushSubscription
  let subscription: PushSubscription | null = null
  try {
    subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as ArrayBuffer,
      })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[push] pushManager.subscribe 失敗', msg)
    // 常見：已封鎖、VAPID key 錯誤、非 HTTPS
    return null
  }

  if (!subscription) return null

  // 4) 寫入 Supabase
  try {
    const { data: sess } = await supabase.auth.getSession()
    const uid = sess.session?.user?.id
    if (!uid) {
      // 未登入：仍回傳 subscription，但不寫 DB（401 情境由呼叫端決定是否導向登入）
      console.warn('[push] 尚未登入，PushSubscription 已建立但未寫入 DB')
      return subscription
    }

    const p256dh = arrayBufferToBase64(subscription.getKey('p256dh'))
    const auth = arrayBufferToBase64(subscription.getKey('auth'))
    if (!p256dh || !auth) {
      console.warn('[push] 無法取得 p256dh/auth key')
      return subscription
    }

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: uid,
        endpoint: subscription.endpoint,
        p256dh,
        auth,
      },
      { onConflict: 'endpoint' },
    )

    if (error) {
      // 401 未授權 / RLS 阻擋
      if (error.code === '401' || error.message.includes('JWT') || error.code === '42501') {
        console.warn('[push] 寫入 push_subscriptions 被拒（未授權/RLS）', error.message)
        return subscription
      }
      throw error
    }
  } catch (err) {
    console.warn('[push] 寫入 Supabase 失敗', err)
    // 訂閱本身已成功，仍回傳 subscription 讓呼叫端可重試寫入
    return subscription
  }

  return subscription
}

/**
 * 取消目前裝置的 Push 訂閱
 * - 呼叫 subscription.unsubscribe()
 * - 從 Supabase 刪除對應 endpoint
 */
export async function unregisterPushSubscription(): Promise<void> {
  if (!isSupported()) return

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    const endpoint = subscription.endpoint

    // 先嘗試取消瀏覽器訂閱
    try {
      const ok = await subscription.unsubscribe()
      if (!ok) console.warn('[push] unsubscribe 回傳 false')
    } catch (err) {
      console.warn('[push] unsubscribe 失敗', err)
    }

    // 再從 DB 刪除
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)

      if (error) {
        if (error.code === '401' || error.code === '42501') {
          console.warn('[push] 刪除 push_subscriptions 被拒（未授權）')
          return
        }
        throw error
      }
    } catch (err) {
      console.warn('[push] 刪除 Supabase push_subscriptions 失敗', err)
    }
  } catch (err) {
    console.warn('[push] unregister 過程異常', err)
  }
}
