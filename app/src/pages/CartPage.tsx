import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtMoney } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import { checkoutWithRetry } from '../lib/checkout'
import { useSharedClock } from '../lib/sharedClock'

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

const RESERVE_MS = 1 * 60 * 1000

/* ───────── 購物車步驟指示（長輩友善：大字＋高對比＋清楚序號）─────────
   用語與訂單進度對齊：下單→結帳→付款（訂單頁另有出貨→完成） */
function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: '下單' },
    { n: 2, label: '結帳' },
    { n: 3, label: '付款' },
  ] as const
  return (
    <div
      className="flex items-center gap-1.5 sm:gap-2"
      aria-label={`目前步驟 ${step} / 3`}
      role="navigation"
    >
      {steps.map((s, i) => {
        const isActive = s.n === step
        const isDone = s.n < step
        return (
          <div key={s.n} className="flex items-center gap-1.5 sm:gap-2 flex-1">
            <div
              className={[
                'flex items-center gap-2 rounded-full px-3 sm:px-3.5 py-2 text-[13px] sm:text-sm font-bold leading-none transition-all',
                isActive
                  ? 'bg-white text-accent-700 shadow-md ring-2 ring-white/60 scale-[1.02]'
                  : isDone
                    ? 'bg-white/90 text-accent-700'
                    : 'bg-white/20 text-white border border-white/40',
              ].join(' ')}
              aria-current={isActive ? 'step' : undefined}
            >
              <span
                className={[
                  'w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-xs sm:text-sm font-extrabold shrink-0',
                  isActive
                    ? 'bg-accent-500 text-white shadow'
                    : isDone
                      ? 'bg-accent-500 text-white'
                      : 'bg-white/25 text-white',
                ].join(' ')}
              >
                {isDone ? '✓' : s.n}
              </span>
              <span className="whitespace-nowrap tracking-wide">{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`h-0.5 flex-1 rounded-full hidden sm:block ${s.n < step ? 'bg-white/80' : 'bg-white/25'}`}
                aria-hidden
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 單一商品倒數 — 長輩友善加大版：大字＋高對比色＋加粗進度條 */
function CountdownBar({ expiresAt, onExpire }: { expiresAt: string; onExpire: (id?: string) => void }) {
  const clock = useSharedClock()
  const target = new Date(expiresAt).getTime()
  const left = Math.max(0, target - clock.nowMs - clock.offsetMs)
  const fired = useRef(false)

  useEffect(() => {
    if (left > 0 || fired.current) return
    fired.current = true
    onExpire()
  }, [left, onExpire])

  const totalSec = Math.ceil(left / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = String(totalSec % 60).padStart(2, '0')
  const pct = Math.max(0, Math.min(100, (left / RESERVE_MS) * 100))
  const urgent = totalSec <= 30
  const warning = totalSec <= 60 && !urgent

  return (
    <div
      className={[
        'rounded-2xl px-3.5 py-3 flex items-center justify-between gap-3 border-2 transition-colors',
        urgent
          ? 'bg-red-50 border-red-300 shadow-sm animate-pulse'
          : warning
            ? 'bg-amber-50 border-amber-200'
            : 'bg-accent-50/80 border-accent-200',
      ].join(' ')}
      role="timer"
      aria-live="polite"
      aria-label={`保留剩餘 ${mm}分${ss}秒`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className={[
            'w-9 h-9 rounded-full flex items-center justify-center text-base shrink-0',
            urgent ? 'bg-red-500 text-white' : warning ? 'bg-amber-500 text-white' : 'bg-accent-500 text-white',
          ].join(' ')}
          aria-hidden
        >
          ⏱
        </span>
        <div className="min-w-0">
          <p
            className={[
              'text-[13px] font-extrabold tracking-wide leading-none',
              urgent ? 'text-red-700' : warning ? 'text-amber-700' : 'text-accent-700',
            ].join(' ')}
          >
            {urgent ? '即將逾時，請盡快結帳！' : warning ? '保留時間快到了' : '已為您保留'}
          </p>
          <p className="text-xs text-ink-500 mt-0.5">逾時會自動取消，幫您釋回庫存</p>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div
          className={[
            'tabular-nums font-black tracking-widest leading-none',
            urgent ? 'text-[26px] text-red-600' : warning ? 'text-[24px] text-amber-600' : 'text-[22px] text-ink-900',
          ].join(' ')}
        >
          {mm}:{ss}
        </div>
        <div className="mt-1.5 w-[92px] h-2 rounded-full bg-white/90 border border-black/5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${urgent ? 'bg-red-500' : warning ? 'bg-amber-500' : 'bg-accent-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  )
}

/** 購物車頁：每件商品獨立 1 分鐘倒數，逾時自動取消釋回庫存 */
export default function CartPage() {
  const { userId } = useAuth()
  const navigate = useNavigate()
  const clock = useSharedClock()
  const [items, setItems] = useState<CartItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [doneOrders, setDoneOrders] = useState<string[]>([])
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const clockRef = useRef(clock)
  useEffect(() => {
    clockRef.current = clock
  }, [clock])

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

  useEffect(() => { if (userId) { // eslint-disable-next-line react/set-state-in-effect -- 外部購物車資料同步，需等伺服器回應後才能更新
    void load() } }, [userId, load])

  // 逾時自動取消：釋回庫存（伺服器端 release_reservation）
  const expireItem = useCallback(async (rid?: string) => {
    const id = rid ?? itemsRef.current.find((x) => new Date(x.expires_at).getTime() <= clockRef.current.nowMs + clockRef.current.offsetMs)?.id
    if (!id) return
    setItems((prev) => prev.filter((x) => x.id !== id))
    setNotice('⌛ 有商品超過 1 分鐘未結帳，已自動取消並釋回庫存')
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

  // 結帳（鎖定價開單；網路異常時安全重試一次）
  const checkoutItem = async (rid: string) => {
    setBusyId(rid)
    setNotice('正在確認訂單，請不要重複按下…')
    try {
      const result = await checkoutWithRetry(rid)
      const res = result.data ?? {}
      const terr = result.error as { status?: number; code?: string; message?: string } | null
      const tmsg = terr ? `${terr.code ?? ''} ${terr.message ?? ''}` : ''
      if ((terr && (terr.status === 401 || /jwt|expired|unauthorized|PGRST301/i.test(tmsg))) || res.reason === 'unauthenticated') {
        // 登入掉了：帶回登入頁，登回來再結帳
        setNotice(null)
        navigate('/login', { replace: true })
        return
      }
      if (result.error || !res.ok) {
        setNotice(res.reason === 'reservation_expired' || res.reason === 'reservation_inactive'
          ? '⌛ 此商品保留時間已過，請重新放入購物車'
          : '⚠️ 目前無法確認結帳結果，請稍後到「我的訂單」查看，先不要重複購買')
        await load()
        return
      }
      setItems((prev) => prev.filter((x) => x.id !== rid))
      if (res.order_no) setDoneOrders((prev) => prev.includes(res.order_no!) ? prev : [...prev, res.order_no!])
      setNotice(null)
    } finally {
      setBusyId(null)
    }
  }

  const total = items.reduce((s, x) => s + Number(x.locked_unit_price) * x.quantity, 0)

  return (
    <div className="min-h-dvh bg-ink-50 pb-28">
      {/* 頂部 — 漸層＋步驟指示同區，長輩一眼看懂流程 */}
      <header className="bg-gradient-to-br from-accent-500 via-accent-500 to-accent-600 px-4 md:px-6 pt-3 pb-4 md:py-5 sticky top-0 z-10 shadow-lg shadow-accent-500/20">
        <div className="max-w-md md:max-w-3xl mx-auto space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[18px] md:text-xl font-black text-white tracking-wide flex items-center gap-2">
                <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-lg shrink-0" aria-hidden>🛒</span>
                購物車
                {items.length > 0 && (
                  <span className="ml-1 bg-white text-accent-600 text-xs font-black px-2.5 py-1 rounded-full shadow-sm">
                    {items.length} 件
                  </span>
                )}
              </h1>
              <p className="text-[13px] text-white/90 mt-1 leading-relaxed">
                每件商品保留 <span className="font-black text-white">1 分鐘</span>，逾時自動取消釋回庫存
              </p>
            </div>
            <Link
              to="/"
              className="shrink-0 h-10 px-4 inline-flex items-center justify-center rounded-full bg-white text-accent-600 text-sm font-extrabold shadow-md active:scale-[0.97] transition"
            >
              ← 繼續逛
            </Link>
          </div>
          <StepIndicator step={items.length > 0 ? 2 : 1} />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-5 space-y-4">
        {/* 結帳成功通知 — 高對比綠底＋大字 */}
        {doneOrders.length > 0 && (
          <div
            className="bg-green-50 border-2 border-green-300 rounded-[20px] px-5 py-4 shadow-sm anim-fade-up"
            role="status"
            aria-live="polite"
          >
            <p className="text-[15px] font-extrabold text-green-800 flex items-start gap-2">
              <span className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center text-sm shrink-0 mt-0.5">✓</span>
              <span>
                結帳成功！訂單已確認<br />
                <span className="font-mono text-sm tracking-wide">編號：{doneOrders.join('、')}</span>
              </span>
            </p>
            <Link
              to="/orders"
              className="mt-3 inline-flex h-11 px-6 items-center justify-center rounded-full bg-green-600 text-white text-sm font-extrabold shadow active:scale-[0.98] transition"
            >
              查看我的訂單 →
            </Link>
          </div>
        )}

        {/* 系統通知 — 琥珀色高對比邊框＋大字 */}
        {notice && (
          <div
            className="bg-amber-50 border-2 border-amber-300 rounded-[20px] px-5 py-4 flex items-start justify-between gap-3 anim-fade-up shadow-sm"
            role="alert"
          >
            <p className="text-[15px] font-bold text-amber-900 leading-relaxed">{notice}</p>
            <button
              onClick={() => setNotice(null)}
              className="shrink-0 h-9 px-4 rounded-full bg-white border-2 border-amber-200 text-sm font-bold text-ink-600 active:scale-[0.97] transition"
              aria-label="關閉通知"
            >
              知道了
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-4 pt-2">
            <div className="skeleton h-36 w-full rounded-[24px]" />
            <div className="skeleton h-36 w-full rounded-[24px]" />
          </div>
        ) : items.length === 0 ? (
          /* 空車狀態 — 溫暖友善＋大按鈕引導 */
          <div className="anim-fade-up">
            <div className="bg-white rounded-[24px] border-2 border-ink-100 shadow-sm px-6 py-10 md:py-14 text-center">
              <div className="w-20 h-20 mx-auto rounded-full bg-accent-50 border-2 border-accent-100 flex items-center justify-center text-4xl" aria-hidden>
                🛒
              </div>
              <h2 className="mt-5 text-[20px] font-black text-ink-900 tracking-wide">購物車空空的</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-500">
                別擔心，去逛逛團購好物吧！<br />
                <span className="text-sm text-ink-400">看到喜歡的先加入購物車，價格會幫您鎖定 1 分鐘</span>
              </p>
              <Link
                to="/"
                className="mt-6 inline-flex h-14 px-8 items-center justify-center rounded-full bg-gradient-to-r from-accent-500 to-accent-600 text-white text-[16px] font-black shadow-lg shadow-accent-500/25 active:scale-[0.98] transition"
              >
                去逛團購 →
              </Link>
              <p className="mt-4 text-xs text-ink-400">💡 提示：加入購物車後，1 分鐘內結帳可享鎖定價</p>
            </div>

            {/* 空車時的小幫手卡片 */}
            <div className="mt-4 bg-white rounded-[20px] border border-ink-100 p-4 flex gap-3 shadow-sm">
              <span className="w-10 h-10 rounded-full bg-ink-50 border border-ink-100 flex items-center justify-center text-lg shrink-0" aria-hidden>💬</span>
              <div>
                <p className="text-sm font-bold text-ink-800">需要幫忙嗎？</p>
                <p className="text-sm text-ink-500 leading-relaxed mt-0.5">
                  若結帳時遇到問題，請聯絡客服或到「我的訂單」查看訂單狀態。
                </p>
                <Link to="/orders" className="mt-2 inline-block text-sm font-bold text-accent-600 underline underline-offset-4">
                  查看我的訂單
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 商品卡片列表 — rounded-[24px] 柔和陰影＋充足留白 */}
            <div className="space-y-4">
              {items.map((item) => {
                const lineTotal = Number(item.locked_unit_price) * item.quantity
                return (
                  <div
                    key={item.id}
                    className="bg-white rounded-[24px] border-2 border-ink-100 shadow-[0_4px_24px_rgba(0,0,0,0.06)] p-5 anim-fade-up"
                  >
                    {/* 商品資訊列 — 大圖＋大字 */}
                    <div className="flex gap-4">
                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-ink-50 border border-ink-100 overflow-hidden shrink-0 flex items-center justify-center">
                        {item.products?.image_url ? (
                          <img src={item.products.image_url} alt={item.products.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-3xl opacity-30" aria-hidden>🎁</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 py-0.5">
                        <Link
                          to={`/product/${item.product_id}`}
                          className="text-[17px] md:text-[18px] font-black text-ink-900 leading-snug line-clamp-2 hover:text-accent-600 transition"
                        >
                          {item.products?.name ?? '商品'}
                        </Link>
                        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-[24px] font-black text-accent-600 tracking-tight tabular-nums">
                            {fmtMoney(item.locked_unit_price)}
                          </span>
                          <span className="text-sm font-bold text-ink-500">
                            × {item.quantity}
                            {item.products?.unit ?? ''}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-green-700">
                            🔒 價格已鎖定
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-400">
                          小計 <span className="font-bold text-ink-700 tabular-nums">{fmtMoney(lineTotal)}</span>
                        </p>
                      </div>
                    </div>

                    {/* 倒數 — 醒目大字＋顏色 urgency */}
                    <div className="mt-4">
                      <CountdownBar expiresAt={item.expires_at} onExpire={() => expireItem(item.id)} />
                    </div>

                    {/* 操作按鈕 — h-14 pill 漸層＋高對比邊框，充足間距防誤觸 */}
                    <div className="mt-4 grid grid-cols-[1fr_auto] gap-3">
                      <button
                        onClick={() => checkoutItem(item.id)}
                        disabled={busyId === item.id}
                        className="h-14 rounded-full bg-gradient-to-r from-accent-500 to-accent-600 text-white text-[16px] font-black shadow-lg shadow-accent-500/25 active:scale-[0.98] transition disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-1.5"
                        aria-label={`結帳 ${item.products?.name ?? '商品'}，金額 ${fmtMoney(lineTotal)}`}
                      >
                        {busyId === item.id ? (
                          '處理中…'
                        ) : (
                          <>
                            <span aria-hidden>✔</span> 結帳 {fmtMoney(lineTotal)}
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => cancelItem(item.id)}
                        disabled={busyId === item.id}
                        className="h-14 px-6 rounded-full border-2 border-ink-200 bg-white text-ink-700 text-[15px] font-extrabold hover:bg-red-50 hover:text-red-600 hover:border-red-200 active:scale-[0.97] transition disabled:opacity-50"
                        aria-label={`取消 ${item.products?.name ?? '商品'}`}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 合計卡 — 圓角大卡＋超大金額字級 */}
            <div className="bg-white rounded-[24px] border-2 border-ink-100 shadow-[0_4px_24px_rgba(0,0,0,0.06)] p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-bold text-ink-500">共 {items.length} 項待結帳</span>
                <span className="text-sm font-bold px-3 py-1 rounded-full bg-ink-900 text-white">
                  步驟 2 / 3
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 pt-1 border-t border-dashed border-ink-200">
                <span className="text-base font-extrabold text-ink-700">合計</span>
                <span className="text-[28px] font-black text-accent-600 tabular-nums tracking-tight">{fmtMoney(total)}</span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-500 bg-ink-50 rounded-2xl px-4 py-3 border border-ink-100">
                <span className="font-bold text-ink-700">ℹ️ 安心結帳：</span>
                以「鎖定價」成交，不受之後降價影響；逾時未結帳的商品會自動取消，回到架上繼續降價（大方向只降不漲，但有人棄單會讓下次降價晚一點）。
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
