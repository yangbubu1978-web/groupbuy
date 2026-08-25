import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Order } from '../lib/types'
import { fmtMoney, fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmDialog'

const STATUS_LABEL: Record<string, string> = {
  pending: '待確認',
  confirmed: '已確認',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  refunding: '退款處理中',
  refunded: '已退款',
  cancelled: '已取消',
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700',
  confirmed: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  shipped: 'bg-indigo-50 text-indigo-700',
  completed: 'bg-ink-100 text-ink-600',
  refunding: 'bg-orange-50 text-orange-700',
  refunded: 'bg-ink-100 text-ink-500',
  cancelled: 'bg-red-50 text-red-600',
}

const STATUS_ICON: Record<string, string> = {
  pending: '⏳', confirmed: '✅', paid: '💳',
  shipped: '🚚', completed: '📦', refunding: '↩️',
  refunded: '💸', cancelled: '❌',
}

/** 電商進度條：五個正向里程碑 */
const PROGRESS_STEPS = ['pending', 'confirmed', 'paid', 'shipped', 'completed'] as const
function progressIndex(status: string): number {
  return PROGRESS_STEPS.indexOf(status as (typeof PROGRESS_STEPS)[number])
}

/** 進行中 = 正向流程尚未走完；已完成分頁放 completed／cancelled／refund* */
const ACTIVE_STATUSES = ['pending', 'confirmed', 'paid', 'shipped']
type Tab = 'active' | 'done'

export default function OrdersPage() {
  const { customer } = useAuth()
  const ask = useConfirm()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('active')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    supabase
      .from('orders')
      .select('*')
      .order('purchased_at', { ascending: false })
      .then(({ data }) => {
        if (alive && data) setOrders(data as Order[])
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [])

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

  // 會員取消訂單（限待確認／已確認；Server 回補庫存）
  const cancelOrder = async (o: Order) => {
    // 兩段式：先彈確認
    if (!(await ask({ title: '取消訂單', message: `確定要取消這筆訂單嗎？\n${o.order_no}｜${o.product_name_snapshot}`, danger: true }))) return
    setCancellingId(o.id)
    setMsg(null)
    try {
      const { data, error } = await supabase.rpc('cancel_own_order', { p_order_id: o.id })
      const res = (data ?? {}) as { ok?: boolean; reason?: string }
      if (error) throw new Error(error.message)
      if (!res.ok) {
        const reasonText: Record<string, string> = {
          unauthenticated: '登入狀態已失效，請重新登入',
          not_found_or_not_owner: '找不到這筆訂單',
          invalid_status: '此訂單目前無法取消（已付款請聯絡管理員）',
        }
        throw new Error(reasonText[res.reason ?? ''] ?? `取消失敗（${res.reason}）`)
      }
      setOrders((prev) =>
        prev.map((x) => (x.id === o.id ? { ...x, status: 'cancelled' as Order['status'] } : x)),
      )
      setMsg({ ok: true, text: '訂單已取消，庫存已釋回' })
    } catch (e) {
      setMsg({ ok: false, text: `❌ ${e instanceof Error ? e.message : '取消失敗'}` })
    } finally {
      setCancellingId(null)
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
              <div className="text-[11px] text-ink-400 mt-0.5">累積訂單</div>
            </div>
            <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
              <div className="text-lg font-bold text-ink-900 tabular-nums">{fmtMoney(totalAmount)}</div>
              <div className="text-[11px] text-ink-400 mt-0.5">消費金額</div>
            </div>
            <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
              <div className="text-lg font-bold text-ink-900 tabular-nums">{totalItems}</div>
              <div className="text-[11px] text-ink-400 mt-0.5">購買件數</div>
            </div>
          </section>
        )}

        {/* 分頁 */}
        {!loading && orders.length > 0 && (
          <section className="grid grid-cols-2 gap-2 anim-fade-up">
            <button
              onClick={() => setTab('active')}
              className={`h-10 rounded-xl border text-sm font-semibold transition ${
                tab === 'active'
                  ? 'bg-ink-900 border-ink-900 text-white shadow-sm'
                  : 'bg-white border-ink-200 text-ink-500'
              }`}
            >
              進行中（{activeOrders.length}）
            </button>
            <button
              onClick={() => setTab('done')}
              className={`h-10 rounded-xl border text-sm font-semibold transition ${
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
            className={`rounded-xl border px-4 py-3 text-sm anim-pop-in ${
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
            <p className="text-sm text-ink-400">目前沒有訂單</p>
            <Link to="/" className="mt-3 inline-block text-sm font-medium text-accent-600">
              去逛團購 →
            </Link>
          </div>
        )}
        {!loading && orders.length > 0 && visible.length === 0 && (
          <div className="text-center py-12 anim-fade-up">
            <div className="text-3xl mb-2">{tab === 'done' ? '📦' : '🛒'}</div>
            <p className="text-sm text-ink-400">
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
                  <p className="mt-0.5 text-xs text-ink-400">
                    {o.order_no} · {fmtDateTime(o.purchased_at)}
                  </p>
                </div>
                <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLE[o.status] ?? ''}`}>
                  {STATUS_ICON[o.status] ?? ''} {STATUS_LABEL[o.status] ?? o.status}
                </span>
              </div>

              {/* 金額 */}
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-ink-500 tabular-nums">
                  {fmtMoney(Number(o.unit_price))} × {o.quantity}
                </span>
                <span className="font-bold text-ink-900 tabular-nums">{fmtMoney(Number(o.total_amount))}</span>
              </div>

              {/* 電商進度條（取消／退款不顯示） */}
              {pIdx >= 0 && (
                <div className="mt-3">
                  <div className="flex items-center">
                    {PROGRESS_STEPS.map((s, idx) => (
                      <div key={s} className="flex-1 flex items-center last:flex-none">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] shrink-0 transition-colors ${
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
                  <div className="flex justify-between mt-1 text-[9px] text-ink-400">
                    <span>下單</span><span className="hidden xs:inline">確認</span><span>付款</span><span className="hidden xs:inline">出貨</span><span>完成</span>
                  </div>
                </div>
              )}

              {/* 取消原因（被取消／退款時顯示） */}
              {(o.status === 'cancelled' || o.status === 'refunded') && (
                <p className="mt-2 text-[11px] text-ink-400">
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
                    className="flex-1 h-10 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white
                               text-xs font-semibold shadow-md shadow-accent-500/25
                               active:scale-[0.98] transition disabled:opacity-50"
                  >
                    {busyId === o.id ? '確認中…' : '✔ 確認訂單'}
                  </button>
                )}
                {(o.status === 'pending' || o.status === 'confirmed') && (
                  <button
                    onClick={() => cancelOrder(o)}
                    disabled={cancellingId === o.id}
                    className="h-10 px-4 rounded-xl border border-red-200 text-red-500
                               text-xs font-semibold active:scale-[0.98] transition disabled:opacity-50"
                  >
                    {cancellingId === o.id ? '取消中…' : '取消訂單'}
                  </button>
                )}
                {/* 再次購買：有 product_id 且商品仍在架上才顯示 */}
                {(o.status === 'completed' || o.status === 'cancelled') && o.product_id && (
                  <Link
                    to={`/product/${o.product_id}`}
                    className="flex-1 h-10 rounded-xl border border-ink-200 text-ink-600
                               text-xs font-semibold flex items-center justify-center active:scale-[0.98] transition"
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
          className="w-full h-11 rounded-xl border border-ink-200 text-sm text-ink-500"
        >
          登出（{customer?.name}）
        </button>
      </div>
    </div>
  )
}
