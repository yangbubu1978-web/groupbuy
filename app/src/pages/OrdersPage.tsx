import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Order } from '../lib/types'
import { fmtMoney, fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import { useSharedClock } from '../lib/sharedClock'

// 狀態文案/樣式/圖示：共用字典單一真相來源（P19）
import { ORDER_STATUS_LABEL as STATUS_LABEL, ORDER_STATUS_STYLE as STATUS_STYLE, ORDER_STATUS_ICON as STATUS_ICON } from '../lib/orderStatus'

/** 電商進度條：P30 簡化版四個正向里程碑（下單→確認→付款→完成） */
const PROGRESS_STEPS = ['pending', 'confirmed', 'paid', 'completed'] as const
function progressIndex(status: string): number {
  return PROGRESS_STEPS.indexOf(status as (typeof PROGRESS_STEPS)[number])
}

/** 進行中 = 正向流程尚未走完；已完成分頁放 completed／cancelled／refund* */
const ACTIVE_STATUSES = ['pending', 'confirmed', 'paid', 'shipped']
type Tab = 'active' | 'done'

/** P29c：待確認訂單倒數（1 分鐘自動過期；歸零即刷新列表由 cron 收走） */
function PendingCountdown({ purchasedAt, onExpire }: { purchasedAt: string; onExpire: () => void }) {
  const clock = useSharedClock()
  const expiresAt = new Date(new Date(purchasedAt).getTime() + 60_000).getTime()
  const left = Math.max(0, Math.ceil((expiresAt - clock.nowMs - clock.offsetMs) / 1000))
  useEffect(() => {
    if (left > 0) return
    onExpire()
  }, [left, onExpire])
  return (
    <div className={`mt-2 rounded-xl px-4 py-2.5 text-sm font-bold flex items-center justify-between border
      ${left <= 20
        ? 'bg-red-50 text-red-700 border-red-200 animate-pulse'
        : 'bg-accent-50 text-accent-700 border-accent-200'}`}
      role="timer"
      aria-label={`訂單確認剩餘 ${left} 秒`}>
      <span>⏳ 請在 {left} 秒內確認訂單</span>
      <span className="text-base tabular-nums">{left}s</span>
    </div>
  )
}

export default function OrdersPage() {
  const { customer } = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('active')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // P29c：抽出載入函式（pending 倒數歸零時也會呼叫刷新）
  const reloadOrders = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .order('purchased_at', { ascending: false })
    if (data) setOrders(data as Order[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void reloadOrders()
  }, [reloadOrders])

  // 客戶自行確認（pending → confirmed）
  const confirmOrder = async (o: Order) => {
    setBusyId(o.id)
    setMsg(null)
    try {
      const { data, error } = await supabase.rpc('confirm_own_order', { p_order_id: o.id })
      const res = (data ?? {}) as { ok?: boolean; reason?: string }
      if (error) throw new Error(error.message)
      if (!res.ok) throw new Error(res.reason ?? '確認失敗')
      setOrders((prev) =>
        prev.map((x) => (x.id === o.id ? { ...x, status: 'confirmed' as Order['status'] } : x)),
      )
      setMsg({ ok: true, text: '✅ 訂單已確認，感謝您！' })
    } catch (e) {
      setMsg({ ok: false, text: `❌ ${e instanceof Error ? e.message : '確認失敗'}` })
    } finally {
      setBusyId(null)
    }
  }

  const activeOrders = orders.filter((o) => ACTIVE_STATUSES.includes(o.status))
  const doneOrders = orders.filter((o) => !ACTIVE_STATUSES.includes(o.status))
  const visible = tab === 'active' ? activeOrders : doneOrders

  // 統計摘要（不含取消與退款）
  const validOrders = orders.filter((o) => !['cancelled', 'refunded'].includes(o.status))
  const totalCount = validOrders.length
  const totalAmount = validOrders.reduce((s, o) => s + Number(o.total_amount), 0)
  const totalItems = validOrders.reduce((s, o) => s + o.quantity, 0)

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white/90 backdrop-blur border-b border-ink-100 px-5 py-4 sticky top-0 z-10">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between">
          <Link to="/" className="w-9 h-9 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-600" aria-label="返回">
            ←
          </Link>
          <h1 className="text-base font-bold text-ink-900 font-display">我的訂單</h1>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-4 space-y-3">
        {/* 統計摘要 */}
        {!loading && orders.length > 0 && (
          <section className="grid grid-cols-3 gap-2 anim-fade-up">
            <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
              <div className="text-lg font-bold text-ink-900 tabular-nums">{totalCount}</div>
              <div className="text-sm text-ink-500 mt-0.5">累積訂單</div>
            </div>
            <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
              <div className="text-lg font-bold text-ink-900 tabular-nums">{fmtMoney(totalAmount)}</div>
              <div className="text-sm text-ink-500 mt-0.5">消費金額</div>
            </div>
            <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
              <div className="text-lg font-bold text-ink-900 tabular-nums">{totalItems}</div>
              <div className="text-sm text-ink-500 mt-0.5">購買件數</div>
            </div>
          </section>
        )}

        {/* 分頁 */}
        {!loading && orders.length > 0 && (
          <section className="grid grid-cols-2 gap-2 anim-fade-up">
            <button
              onClick={() => setTab('active')}
              className={`h-12 rounded-xl border text-base font-semibold transition ${
                tab === 'active'
                  ? 'bg-ink-900 border-ink-900 text-white shadow-sm'
                  : 'bg-white border-ink-200 text-ink-500'
              }`}
            >
              進行中（{activeOrders.length}）
            </button>
            <button
              onClick={() => setTab('done')}
              className={`h-12 rounded-xl border text-base font-semibold transition ${
                tab === 'done'
                  ? 'bg-ink-900 border-ink-900 text-white shadow-sm'
                  : 'bg-white border-ink-200 text-ink-500'
              }`}
            >
              完成／取消（{doneOrders.length}）
            </button>
          </section>
        )}

        {/* 操作結果提示 */}
        {msg && (
          <div
            role="alert"
            className={`rounded-xl border px-4 py-3 text-base anim-pop-in ${
              msg.ok ? 'bg-green-50 border-green-100 text-green-700' : 'bg-red-50 border-red-100 text-red-600'
            }`}
          >
            {msg.text}
          </div>
        )}

        {loading && (
          <div className="space-y-3 pt-2">
            <div className="skeleton h-28 w-full" />
            <div className="skeleton h-28 w-full" />
          </div>
        )}
        {!loading && orders.length === 0 && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🧾</div>
            <p className="text-base text-ink-400">目前沒有訂單</p>
            <Link to="/" className="mt-3 inline-block text-base font-medium text-accent-600">
              去逛團購 →
            </Link>
          </div>
        )}
        {!loading && orders.length > 0 && visible.length === 0 && (
          <div className="text-center py-12 anim-fade-up">
            <div className="text-3xl mb-2">{tab === 'done' ? '📦' : '🛒'}</div>
            <p className="text-base text-ink-400">
              {tab === 'done' ? '還沒有完成或取消的訂單' : '沒有進行中的訂單'}
            </p>
          </div>
        )}

        {visible.map((o, i) => {
          const pIdx = progressIndex(o.status)
          return (
            <div
              key={o.id}
              className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm anim-fade-up"
              style={{ animationDelay: `${Math.min(i * 50, 250)}ms` }}
            >
              {/* 標題列 */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink-900 truncate">{o.product_name_snapshot}</h3>
                  <p className="mt-0.5 text-sm text-ink-500">
                    {o.order_no} · {fmtDateTime(o.purchased_at)}
                  </p>
                </div>
                <span className={`shrink-0 text-sm font-medium px-3 py-1 rounded-full ${STATUS_STYLE[o.status] ?? ''}`}>
                  {STATUS_ICON[o.status] ?? ''} {STATUS_LABEL[o.status] ?? o.status}
                </span>
              </div>

              {/* 金額 */}
              <div className="mt-2 flex items-center justify-between text-base">
                <span className="text-ink-500 tabular-nums">
                  {fmtMoney(Number(o.unit_price))} × {o.quantity}
                </span>
                <span className="font-bold text-ink-900 tabular-nums">{fmtMoney(Number(o.total_amount))}</span>
              </div>

              {/* P29c：待確認倒數（1 分鐘過期） */}
              {o.status === 'pending' && (
                <PendingCountdown
                  purchasedAt={o.purchased_at}
                  onExpire={() => void reloadOrders()}
                />
              )}

              {/* 電商進度條（取消／退款不顯示） */}
              {pIdx >= 0 && (
                <div className="mt-3">
                  <div className="flex items-center">
                    {PROGRESS_STEPS.map((s, idx) => (
                      <div key={s} className="flex-1 flex items-center last:flex-none">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 transition-colors ${
                            idx <= pIdx ? 'bg-accent-500 text-white' : 'bg-ink-100 text-ink-400'
                          }`}
                        >
                          {idx < pIdx ? '✓' : idx + 1}
                        </div>
                        {idx < PROGRESS_STEPS.length - 1 && (
                          <div className={`flex-1 h-0.5 mx-0.5 ${idx < pIdx ? 'bg-accent-500' : 'bg-ink-100'}`} />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between mt-1 text-[11px] text-ink-600">
                    <span>下單</span><span>結帳</span><span>付款</span><span>領貨</span>
                  </div>
                </div>
              )}

              {/* 取消原因（被取消／退款時顯示） */}
              {(o.status === 'cancelled' || o.status === 'refunded') && (
                <p className="mt-2 text-sm text-ink-500">
                  {o.cancelled_by === 'member' ? '由您自行取消' : o.status === 'refunded' ? '退款已完成' : '此訂單已取消'}
                  {o.cancel_reason ? `・${o.cancel_reason}` : ''}
                </p>
              )}

              {/* 動作區 */}
              <div className="mt-3 flex gap-2">
                {o.status === 'pending' && (
                  <button
                    onClick={() => confirmOrder(o)}
                    disabled={busyId === o.id}
                    className="flex-1 h-12 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white
                               text-base font-bold shadow-md shadow-accent-500/25
                               active:scale-[0.98] transition disabled:opacity-50"
                  >
                    {busyId === o.id ? '確認中…' : '✔ 確認訂單'}
                  </button>
                )}
                {/* 會員自助取消已移除（2026-08-25）：降價商城取消重買＝零風險套利，
                    誤購請聯絡管理員由後台處理 */}
                {/* 再次購買：有 product_id 且商品仍在架上才顯示 */}
                {(o.status === 'completed' || o.status === 'cancelled') && o.product_id && (
                  <Link
                    to={`/product/${o.product_id}`}
                    className="flex-1 h-12 rounded-xl border border-ink-200 text-ink-700
                               text-base font-bold flex items-center justify-center active:scale-[0.98] transition"
                  >
                    🛒 再買一次
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </main>

      {/* 登出 */}
      <div className="max-w-md md:max-w-3xl mx-auto px-4 mt-10">
        <button
          onClick={() => supabase.auth.signOut()}
          className="w-full h-11 rounded-xl border border-ink-200 text-base text-ink-500"
        >
          登出（{customer?.name}）
        </button>
      </div>
    </div>
  )
}
