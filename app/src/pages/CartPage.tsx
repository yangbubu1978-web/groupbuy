import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtMoney } from '../lib/types'
import { useAuth } from '../context/AuthContext'

/** 購物車項目（cart_reservations + products embed） */
interface CartItem {
  id: string
  product_id: string
  quantity: number
  locked_unit_price: number
  reserved_at: string
  expires_at: string
  products: {
    id: string
    name: string
    image_url: string | null
    unit: string | null
  } | null
}

const RESERVE_MS = 3 * 60 * 1000

/** 單一商品倒數（3:00 → 0；歸零觸發 onExpire） */
function CountdownBar({ expiresAt, onExpire }: { expiresAt: string; onExpire: (id?: string) => void }) {
  const target = new Date(expiresAt).getTime()
  const [left, setLeft] = useState(Math.max(0, target - Date.now()))
  const fired = useRef(false)

  useEffect(() => {
    fired.current = false
    const id = setInterval(() => {
      const ms = Math.max(0, target - Date.now())
      setLeft(ms)
      if (ms <= 0 && !fired.current) {
        fired.current = true
        clearInterval(id)
        onExpire()
      }
    }, 250)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const totalSec = Math.ceil(left / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = String(totalSec % 60).padStart(2, '0')
  const pct = Math.max(0, Math.min(100, (left / RESERVE_MS) * 100))
  const urgent = totalSec <= 60

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-sm font-bold mb-1">
        <span className={urgent ? 'text-red-600' : 'text-accent-700'}>
          {urgent ? '⏱ 即將逾時' : '⏱ 保留中'}
        </span>
        <span className={`tabular-nums ${urgent ? 'text-red-600' : 'text-ink-900'}`}>{mm}:{ss}</span>
      </div>
      <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-250 ${urgent ? 'bg-red-500' : 'bg-accent-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** 購物車頁：每件商品獨立 3 分鐘倒數，逾時自動取消釋回庫存 */
export default function CartPage() {
  const { userId } = useAuth()
  const [items, setItems] = useState<CartItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [doneOrders, setDoneOrders] = useState<string[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('cart_reservations')
      .select('id, product_id, quantity, locked_unit_price, reserved_at, expires_at, products(id, name, image_url, unit)')
      .eq('user_id', userId ?? '')
      .eq('status', 'active')
      .order('reserved_at', { ascending: true })
    setItems((data ?? []) as unknown as CartItem[])
    setLoading(false)
  }, [userId])

  useEffect(() => { if (userId) load() }, [userId, load])

  // 逾時自動取消：釋回庫存（伺服器端 release_reservation）
  const expireItem = useCallback(async (rid?: string) => {
    const id = rid ?? itemsRef.current.find((x) => new Date(x.expires_at).getTime() <= Date.now())?.id
    if (!id) return
    setItems((prev) => prev.filter((x) => x.id !== id))
    setNotice('⌛ 有商品超過 3 分鐘未結帳，已自動取消並釋回庫存')
    try {
      await supabase.rpc('release_reservation', { p_reservation_id: id })
    } catch {
      // 伺服器 cron 也會兜底回收，前端靜默即可
    }
  }, [])

  // 手動取消
  const cancelItem = async (rid: string) => {
    setBusyId(rid)
    try {
      await supabase.rpc('release_reservation', { p_reservation_id: rid })
      setItems((prev) => prev.filter((x) => x.id !== rid))
      setNotice('✅ 已取消，庫存已釋回')
    } finally {
      setBusyId(null)
    }
  }

  // 結帳（鎖定價開單）
  const checkoutItem = async (rid: string) => {
    setBusyId(rid)
    try {
      const { data, error } = await supabase.rpc('checkout_reservation', { p_reservation_id: rid })
      const res = (data ?? {}) as { ok?: boolean; order_no?: string; reason?: string }
      if (error || !res.ok) {
        setNotice(res.reason === 'reservation_expired' || res.reason === 'reservation_inactive'
          ? '⌛ 此商品保留時間已過，請重新放入購物車'
          : '⚠️ 結帳失敗，請稍後再試')
        await load()
        return
      }
      setItems((prev) => prev.filter((x) => x.id !== rid))
      if (res.order_no) setDoneOrders((prev) => [...prev, res.order_no!])
    } finally {
      setBusyId(null)
    }
  }

  const total = items.reduce((s, x) => s + Number(x.locked_unit_price) * x.quantity, 0)

  return (
    <div className="min-h-dvh bg-ink-50 pb-24">
      {/* 頂部（跟首頁同款橘色漸層） */}
      <header className="bg-gradient-to-r from-accent-500 to-accent-600 px-5 py-4 sticky top-0 z-10 shadow-md">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-extrabold text-white tracking-wide">🛒 購物車</h1>
            <p className="text-xs text-accent-100 mt-0.5">
              每件商品保留 3 分鐘，逾時自動取消釋回庫存
            </p>
          </div>
          <Link to="/" className="text-sm font-bold px-4 py-2 rounded-full border border-white/60 text-white hover:bg-white/15 transition">
            繼續逛
          </Link>
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-4 space-y-3">
        {/* 結帳成功通知 */}
        {doneOrders.length > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-2xl px-4 py-3 text-sm text-green-800 anim-fade-up">
            🎉 結帳成功！訂單編號：{doneOrders.join('、')}
            <Link to="/orders" className="ml-2 font-bold underline">查看訂單</Link>
          </div>
        )}
        {/* 系統通知（逾時/取消） */}
        {notice && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800 anim-fade-up">
            {notice}
            <button onClick={() => setNotice(null)} className="ml-2 text-ink-500 underline">關閉</button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-sm text-ink-400">載入中…</div>
        ) : items.length === 0 ? (
          <div className="text-center py-20 anim-fade-up">
            <div className="text-5xl mb-3">🛒</div>
            <p className="text-base text-ink-500 mb-4">購物車是空的</p>
            <Link to="/" className="inline-block h-11 px-6 leading-[2.75rem] rounded-xl bg-ink-900 text-white text-sm font-semibold">
              去逛逛 →
            </Link>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <div key={item.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm anim-fade-up">
                <div className="flex gap-3">
                  <div className="w-16 h-16 rounded-xl bg-ink-100 overflow-hidden shrink-0 flex items-center justify-center">
                    {item.products?.image_url ? (
                      <img src={item.products.image_url} alt={item.products.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-2xl opacity-30">🎁</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <Link to={`/product/${item.product_id}`} className="text-base font-bold text-ink-900 line-clamp-2 hover:underline">
                      {item.products?.name ?? '商品'}
                    </Link>
                    <p className="mt-1 text-base">
                      <span className="font-extrabold text-accent-600">{fmtMoney(item.locked_unit_price)}</span>
                      <span className="text-ink-500"> × {item.quantity}{item.products?.unit ?? ''}</span>
                      <span className="ml-2 text-sm text-ink-400">🔒 價格已鎖定</span>
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <CountdownBar expiresAt={item.expires_at} onExpire={() => expireItem(item.id)} />
                </div>
                <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <button
                    onClick={() => checkoutItem(item.id)}
                    disabled={busyId === item.id}
                    className="h-11 rounded-xl bg-accent-500 text-white text-sm font-bold shadow active:scale-[0.98] transition disabled:opacity-50"
                  >
                    {busyId === item.id ? '處理中…' : `✔ 結帳 ${fmtMoney(Number(item.locked_unit_price) * item.quantity)}`}
                  </button>
                  <button
                    onClick={() => cancelItem(item.id)}
                    disabled={busyId === item.id}
                    className="h-11 px-4 rounded-xl border border-ink-200 text-ink-600 text-sm font-semibold hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ))}
            {/* 合計 */}
            <div className="flex items-center justify-between px-2 pt-1 text-base">
              <span className="text-ink-500">共 {items.length} 項待結帳</span>
              <span className="font-extrabold text-ink-900">合計 {fmtMoney(total)}</span>
            </div>
            <p className="px-2 text-sm text-ink-400 leading-relaxed">
              ℹ️ 結帳以「鎖定價」成交，不受之後降價影響；逾時未結帳的商品會自動取消，商品以當前降價價格繼續販售（價格只會更低，不會回漲）。
            </p>
          </>
        )}
      </main>
    </div>
  )
}
