import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Order, OrderStatus } from '../lib/types'
import { fmtMoney, fmtDateTime } from '../lib/types'
import {
  ORDER_STATUS_LABEL, ORDER_STATUS_STYLE, ORDER_STATUS_ICON, NEXT_STATUSES,
} from '../lib/orderStatus'
import { useAuth } from '../context/AuthContext'

type FilterKey = 'all' | OrderStatus

/** 歷史列（order_status_history） */
interface HistoryRow {
  id: string
  from_status: string | null
  to_status: string
  note: string | null
  created_at: string
}

/** 確認對話框狀態：danger 動作一律二段確認＋原因 */
interface ConfirmState {
  order: Order
  to: OrderStatus
  label: string
  danger: boolean
  needsReason: boolean
}

/** 需要「原因」的目標狀態（寫入 cancel_reason，匯出表會帶出） */
const REASON_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunding', 'refunded'])
/** 本地時區日期字串 → 當天起訖的 epoch ms（含頭含尾） */
const dayStartMs = (s: string): number => new Date(`${s}T00:00:00`).getTime()
const dayEndMs = (s: string): number => new Date(`${s}T23:59:59.999`).getTime()
/** 訂單列表輪詢間隔（與前台列表 30s 一致；分頁隱藏時暫停） */
const POLL_MS = 30_000

export default function AdminOrdersPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Map<string, { name: string; phone: string }>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [keyword, setKeyword] = useState('')
  /** 操作結果：ok/err 分流樣式，8 秒後自動消失 */
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  const [reason, setReason] = useState('')
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({})
  /** 匯出範圍：預設僅有效訂單（排除已取消／已退款），可關閉看全流水 */
  const [exportValidOnly, setExportValidOnly] = useState(true)
  /** 日期範圍篩選（本地時區 YYYY-MM-DD；含頭含尾） */
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  /** 新訂單提醒：比對上一輪 pending 數量 */
  const prevPendingRef = useRef<number | null>(null)
  const [newOrderAlert, setNewOrderAlert] = useState(false)

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async (silent = false) => {
    if (!silent) { setLoading(true); setLoadError(null) }
    try {
      const [{ data, error }, { data: custs, error: custErr }] = await Promise.all([
        supabase.from('orders').select('*').order('purchased_at', { ascending: false }),
        supabase.from('customers').select('auth_user_id, name, phone'),
      ])
      if (error) throw error
      if (custErr) throw custErr
      if (data) {
        const next = data as Order[]
        // 新訂單偵測（事件驅動）：pending 數量增加 → 響鈴；首次載入只建立基準線
        const n = next.filter((o) => o.status === 'pending').length
        if (prevPendingRef.current !== null && n > prevPendingRef.current) {
          setNewOrderAlert(true)
        }
        prevPendingRef.current = n
        setOrders(next)
      }
      if (custs) setCustomers(new Map(custs.map((c) => [c.auth_user_id ?? '', { name: c.name, phone: c.phone }])))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '載入失敗，請檢查網路後重試')
    } finally {
      setLoading(false)
    }
  }
  // 初始載入（lint 規則針對 effect 內同步 setState；load 是 async，實際 setState 在微任務後）
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [])

  // ---- 30 秒輪詢：新訂單即時感知（分頁隱藏時暫停，回來立刻補抓） ----
  useEffect(() => {
    let timer: number | undefined
    timer = window.setInterval(() => { if (!document.hidden) void load(true) }, POLL_MS)
    const onVis = () => { if (!document.hidden) void load(true) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  /** 狀態轉移：走 admin Edge Function → SQL 狀態機（含庫存回補） */
  const transition = async (o: Order, next: OrderStatus, why?: string) => {
    setBusyId(o.id)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      const fnBase = import.meta.env.VITE_SUPABASE_URL as string
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const resp = await fetch(`${fnBase}/functions/v1/admin`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          apikey: anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'transitionOrder',
          orderId: o.id,
          status: next,
          reason: why?.trim() || undefined,
        }),
      })
      const res = (await resp.json()) as { ok?: boolean; reason?: string; message?: string }
      if (!resp.ok || !res.ok) throw new Error(res.reason ?? res.message ?? `HTTP ${resp.status}`)
      await load(true)
      setConfirming(null)
      setReason('')
      setActionMsg({ ok: true, text: `✅ ${o.order_no} → ${ORDER_STATUS_LABEL[next]}` })
    } catch (e) {
      setActionMsg({ ok: false, text: `❌ ${e instanceof Error ? e.message : '操作失敗'}` })
    } finally {
      setBusyId(null)
    }
  }

  // actionMsg 自動消失（8 秒）
  useEffect(() => {
    if (!actionMsg) return
    const t = window.setTimeout(() => setActionMsg(null), 8000)
    return () => window.clearTimeout(t)
  }, [actionMsg])

  /** 展開/收合歷史時間線（懶載入，每單抓一次後快取） */
  const toggleHistory = async (orderId: string) => {
    if (historyFor === orderId) { setHistoryFor(null); return }
    setHistoryFor(orderId)
    if (history[orderId]) return
    const { data, error } = await supabase
      .from('order_status_history')
      .select('id, from_status, to_status, note, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
    if (!error && data) {
      setHistory((h) => ({ ...h, [orderId]: data as HistoryRow[] }))
    } else {
      setHistory((h) => ({ ...h, [orderId]: [] }))
    }
  }

  // ---- 篩選第一層：chips＋搜尋（手機號碼正規化：+886/符號都能搜到） ----
  const searched = useMemo(() => {
    let list = orders
    if (filter !== 'all') list = list.filter((o) => o.status === filter)
    const kwRaw = keyword.trim()
    const kw = kwRaw.toLowerCase()
    if (kw) {
      const kwDigits = kwRaw.replace(/\D/g, '')
      const kwAlt = kwDigits.startsWith('886') ? '0' + kwDigits.slice(3) : kwDigits
      list = list.filter((o) => {
        const c = customers.get(o.user_id)
        const phoneDigits = (c?.phone ?? '').replace(/\D/g, '')
        return (
          o.order_no.toLowerCase().includes(kw) ||
          o.product_name_snapshot.toLowerCase().includes(kw) ||
          o.sku_snapshot.toLowerCase().includes(kw) ||
          (c?.name ?? '').toLowerCase().includes(kw) ||
          (!!kwDigits && phoneDigits.includes(kwDigits)) ||
          (!!kwAlt && phoneDigits.includes(kwAlt))
        )
      })
    }
    // 日期範圍（含頭含尾，以 purchased_at 為準）
    if (dateFrom) {
      const from = dayStartMs(dateFrom)
      list = list.filter((o) => new Date(o.purchased_at).getTime() >= from)
    }
    if (dateTo) {
      const to = dayEndMs(dateTo)
      list = list.filter((o) => new Date(o.purchased_at).getTime() <= to)
    }
    return list
  }, [orders, filter, keyword, customers, dateFrom, dateTo])

  // ---- 篩選第二層：「全部」分頁預設隱藏已取消／已退款（點「已取消」chip 仍可查看，不滅證） ----
  const filtered = useMemo(
    () =>
      filter === 'all'
        ? searched.filter((o) => !['cancelled', 'refunded'].includes(o.status))
        : searched,
    [searched, filter],
  )

  // ---- 統計卡：跟隨當前篩選範圍（日期＋chips＋搜尋），月報表體驗一致 ----
  // 待處理/退款中例外：永遠看全站（管理員的待辦不該被日期藏起來）
  const stats = useMemo(() => {
    const inScope = (o: Order) =>
      searched.some((s) => s.id === o.id)
    const valid = orders.filter((o) => !['cancelled', 'refunded'].includes(o.status))
    const scopedValid = valid.filter(inScope)
    return {
      total: searched.length,
      revenue: scopedValid.reduce((s, o) => s + Number(o.total_amount), 0),
      needAction: orders.filter((o) => ['pending', 'confirmed', 'paid'].includes(o.status)).length,
      refunding: orders.filter((o) => o.status === 'refunding').length,
    }
  }, [orders, searched])

  // ---- 匯出 Excel（.xls HTML 格式；合計列欄位已對齊） ----
  const exportXls = async () => {
    setBusyId('__export__')
    try {
      const [{ data: products }] = await Promise.all([
        supabase.from('products').select('id, sku, item_no, unit, items_per_unit'),
      ])
      const prodMap = new Map((products ?? []).map((p: { id: string; sku: string; item_no?: string; unit?: string; items_per_unit?: number }) => [p.id, p]))

      const rows: (string | number)[][] = [[
        '訂單編號', '時間', '客戶姓名', '客戶手機', '商品名稱', '商品品號', 'SKU',
        '銷售單位', '數量(單位)', '單價', '金額', '換算單件總數',
        '狀態', '取消者', '取消/退款原因',
      ]]
      // 匯出來源＝chips＋搜尋結果，「已取消/已退款」由開關控制（與列表顯示規則獨立）
      const exportList = (exportValidOnly
        ? searched.filter((o) => !['cancelled', 'refunded'].includes(o.status))
        : searched) as (Order & { user_id: string })[]
      let sumQty = 0
      let sumAmount = 0
      let sumUnits = 0
      for (const o of exportList) {
        const p = prodMap.get(o.product_id ?? '')
        const ipu = Math.max(1, Number(p?.items_per_unit ?? 1))
        const c = customers.get(o.user_id)
        sumQty += o.quantity
        sumAmount += Number(o.total_amount)
        sumUnits += o.quantity * ipu
        rows.push([
          o.order_no,
          new Date(o.purchased_at).toLocaleString('zh-TW'),
          c?.name ?? '',
          c?.phone ?? '',
          o.product_name_snapshot,
          p?.item_no ?? '',
          o.sku_snapshot,
          p?.unit ?? '件',
          o.quantity,
          Number(o.unit_price),
          Number(o.total_amount),
          o.quantity * ipu,
          ORDER_STATUS_LABEL[o.status],
          o.cancelled_by === 'member' ? '會員' : o.cancelled_by === 'admin' ? '管理員' : '',
          o.cancel_reason ?? '',
        ])
      }
      // 彙總列：15 欄對齊——數量=第9欄、金額=第11欄、換算單件總數=第12欄
      rows.push([])
      rows.push(['合計', `${exportList.length} 筆${exportValidOnly ? '（僅有效訂單）' : '（含取消/退款）'}`, '', '', '', '', '', '', sumQty, '', sumAmount, sumUnits])
      // HTML <table> 包成 .xls：Excel 97-2003 可直接開啟
      const esc = (v: string | number) =>
        String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const trs = rows
        .map((r, ri) => {
          const cells = r
            .map((c) => {
              if (typeof c === 'number') {
                return `<td style="mso-number-format:'0'">${c}</td>`
              }
              if (ri === 0) return `<th style="background:#f3ede0;font-weight:bold">${esc(c)}</th>`
              // 文字儲存格：強制文字格式（手機／品號／SKU 開頭 0 安全）
              return `<td style="mso-number-format:'@'">${esc(c)}</td>`
            })
            .join('')
          return `<tr>${cells}</tr>`
        })
        .join('')
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>訂單報表</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body><table border="1">${trs}</table></body></html>`
      const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `訂單報表_${exportValidOnly ? '有效訂單' : '全部'}_${new Date().toISOString().slice(0, 10)}.xls`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusyId(null)
    }
  }

  /** 日期快速選：今天／近7天／本月／上月（YYYY-MM-DD 本地時區） */
  const applyQuickDate = (kind: 'today' | 'last7' | 'thisMonth' | 'lastMonth') => {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const now = new Date()
    if (kind === 'today') {
      const t = fmt(now)
      setDateFrom(t); setDateTo(t)
    } else if (kind === 'last7') {
      const d = new Date(now); d.setDate(d.getDate() - 6)
      setDateFrom(fmt(d)); setDateTo(fmt(now))
    } else if (kind === 'thisMonth') {
      setDateFrom(fmt(new Date(now.getFullYear(), now.getMonth(), 1))); setDateTo(fmt(now))
    } else {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      setDateFrom(fmt(first)); setDateTo(fmt(last))
    }
  }
  const hasDateFilter = !!(dateFrom || dateTo)

  const FILTERS: { key: FilterKey; label: string }[] = [
    { key: 'all', label: `全部 ${orders.length}` },
    { key: 'pending', label: `待確認 ${orders.filter((o) => o.status === 'pending').length}` },
    { key: 'confirmed', label: `已確認 ${orders.filter((o) => o.status === 'confirmed').length}` },
    { key: 'paid', label: `已付款 ${orders.filter((o) => o.status === 'paid').length}` },
    { key: 'shipped', label: `已出貨 ${orders.filter((o) => o.status === 'shipped').length}` },
    { key: 'refunding', label: `退款中 ${stats.refunding}` },
    { key: 'completed', label: `已完成 ${orders.filter((o) => o.status === 'completed').length}` },
    { key: 'cancelled', label: `已取消 ${orders.filter((o) => o.status === 'cancelled').length}` },
  ]

  /** 按鈕點下 → 需要確認的開 Modal、純前進的直接執行 */
  const onActionClick = (o: Order, a: { to: OrderStatus; label: string; danger?: boolean }) => {
    if (a.danger || REASON_STATUSES.has(a.to)) {
      setReason('')
      setConfirming({ order: o, to: a.to, label: a.label, danger: !!a.danger, needsReason: REASON_STATUSES.has(a.to) })
    } else {
      void transition(o, a.to)
    }
  }

  return (
    <main className="space-y-3">
      {/* 標題列＋匯出 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-ink-900">
            訂單管理
            {newOrderAlert && (
              <button
                onClick={() => { setFilter('pending'); setNewOrderAlert(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="ml-2 align-middle h-8 px-3 rounded-full bg-red-500 text-white text-xs font-bold animate-bounce"
                aria-label="有新訂單，點擊查看待確認"
              >
                🔔 有新訂單！
              </button>
            )}
          </h1>
          <p className="text-sm md:text-base text-ink-500">查看與匯出成交紀錄</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button onClick={exportXls} disabled={busyId === '__export__'}
            className="h-10 px-4 rounded-xl bg-ink-900 text-white text-sm font-semibold active:scale-[0.98] transition disabled:opacity-50">
            {busyId === '__export__' ? '匯出中…' : '⬇ 匯出 Excel'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-ink-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={exportValidOnly}
              onChange={(e) => setExportValidOnly(e.target.checked)}
              className="w-4 h-4 accent-accent-500"
            />
            僅有效訂單（排除取消/退款）
          </label>
        </div>
      </div>

      {/* 統計卡 */}
      <section className="grid grid-cols-3 gap-2 anim-fade-up">
        <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
          <div className="text-lg font-bold text-ink-900 tabular-nums">{stats.total}</div>
          <div className="text-xs text-ink-500 mt-0.5">{hasDateFilter ? '範圍內訂單' : '總訂單'}</div>
        </div>
        <div className="bg-white rounded-xl border border-accent-200 bg-gradient-to-br from-accent-50 to-white p-3 text-center shadow-sm">
          <div className="text-lg font-bold text-accent-600 tabular-nums">{fmtMoney(stats.revenue)}</div>
          <div className="text-xs text-ink-500 mt-0.5">有效營收</div>
        </div>
        <div className={`rounded-xl border p-3 text-center shadow-sm ${stats.needAction > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-ink-100'}`}>
          <div className={`text-lg font-bold tabular-nums ${stats.needAction > 0 ? 'text-amber-700' : 'text-ink-900'}`}>
            {stats.needAction}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">待處理</div>
        </div>
      </section>

      {/* 操作結果提示：成功綠 / 失敗紅 */}
      {actionMsg && (
        <div role="alert" aria-live="polite" className={`rounded-xl px-4 py-2.5 text-sm text-center anim-pop-in shadow-sm border ${
          actionMsg.ok ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600'
        }`}>
          {actionMsg.text}
        </div>
      )}

      {/* 載入失敗：明確重試入口，不再假裝空態 */}
      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
          <p className="text-sm text-red-600 font-medium">⚠️ 訂單載入失敗：{loadError}</p>
          <button onClick={() => void load()}
            className="mt-2 h-11 px-6 rounded-xl bg-red-500 text-white text-sm font-bold active:scale-[0.98] transition">
            🔄 重新載入
          </button>
        </div>
      )}

      {/* 搜尋 */}
      <input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        inputMode="search"
        placeholder="搜尋：訂單編號／商品／SKU／客戶／手機"
        className="w-full h-11 px-4 rounded-xl border border-ink-200 bg-white text-base placeholder:text-ink-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus:border-accent-400"
      />

      {/* 日期篩選：起訖＋快速選＋清除 */}
      <div className="bg-white rounded-2xl border border-ink-100 p-3 shadow-sm space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-ink-700 shrink-0">📅 日期</span>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="起始日期"
            className="flex-1 min-w-0 h-11 px-2.5 rounded-xl border border-ink-200 bg-white text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus:border-accent-400"
          />
          <span className="text-ink-400 shrink-0">～</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="結束日期"
            className="flex-1 min-w-0 h-11 px-2.5 rounded-xl border border-ink-200 bg-white text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus:border-accent-400"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([
            ['today', '今天'], ['last7', '近 7 天'], ['thisMonth', '本月'], ['lastMonth', '上月'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => applyQuickDate(k)}
              className="h-9 px-3 rounded-full text-xs font-semibold bg-ink-50 border border-ink-200 text-ink-600 hover:bg-accent-50 hover:border-accent-300 hover:text-accent-700 transition"
            >
              {label}
            </button>
          ))}
          {hasDateFilter && (
            <button
              onClick={() => { setDateFrom(''); setDateTo('') }}
              className="h-9 px-3 rounded-full text-xs font-semibold border border-red-200 text-red-500 hover:bg-red-50 transition ml-auto"
            >
              ✕ 清除日期
            </button>
          )}
        </div>
      </div>

      {/* 狀態篩選 chips */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`shrink-0 h-10 px-3.5 rounded-full text-sm font-semibold transition ${
              filter === f.key
                ? 'bg-ink-900 text-white'
                : 'bg-white border border-ink-200 text-ink-600'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 訂單列表 */}
      {loading && orders.length === 0 && (
        <p className="text-center text-sm text-ink-400 py-12">載入中…</p>
      )}
      {!loading && !loadError && filtered.length === 0 && (
        <p className="text-center text-sm text-ink-400 py-12">沒有符合條件的訂單</p>
      )}
      {filtered.map((o) => {
        const c = customers.get(o.user_id)
        const actions = NEXT_STATUSES[o.status] ?? []
        const hist = history[o.id]
        return (
          <div key={o.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-bold text-ink-900">{o.product_name_snapshot}</h3>
                <p className="mt-0.5 text-xs text-ink-500">
                  {o.order_no} · {fmtDateTime(o.purchased_at)}
                </p>
                <p className="mt-0.5 text-xs text-ink-600">
                  👤 {c?.name ?? '—'}　📞 {c?.phone ?? '—'}
                </p>
              </div>
              <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${ORDER_STATUS_STYLE[o.status]}`}>
                {ORDER_STATUS_ICON[o.status]} {ORDER_STATUS_LABEL[o.status]}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-ink-500 tabular-nums">
                {fmtMoney(Number(o.unit_price))} × {o.quantity}
              </span>
              <span className="font-bold text-ink-900 tabular-nums">{fmtMoney(Number(o.total_amount))}</span>
            </div>

            {(o.cancel_reason || o.note) && (
              <p className="mt-1.5 text-xs text-orange-600">
                {o.note ? `📝 ${o.note} ` : ''}{o.cancel_reason ?? ''}
              </p>
            )}

            {/* 狀態機動作按鈕（危險動作走二段確認） */}
            {actions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.map((a) => (
                  <button
                    key={a.to}
                    onClick={() => onActionClick(o, a)}
                    disabled={busyId === o.id}
                    className={`h-10 px-3.5 rounded-xl text-sm font-semibold active:scale-[0.98] transition disabled:opacity-50 ${
                      a.danger ? 'border border-red-200 text-red-500' : 'bg-ink-900 text-white'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}

            {/* 歷史時間線切換 */}
            <button
              onClick={() => void toggleHistory(o.id)}
              aria-expanded={historyFor === o.id}
              className="mt-2 text-xs text-ink-500 underline underline-offset-2 hover:text-ink-700 transition"
            >
              {historyFor === o.id ? '收合履歷 ▲' : '📋 狀態履歷 ▼'}
            </button>
            {historyFor === o.id && (
              <ol className="mt-2 space-y-1.5 border-l-2 border-ink-100 pl-3 anim-fade-up">
                {(hist ?? []).map((h) => (
                  <li key={h.id} className="text-xs text-ink-600">
                    <span className="tabular-nums">{fmtDateTime(h.created_at)}</span>
                    {' — '}
                    {h.from_status
                      ? `${ORDER_STATUS_LABEL[h.from_status as OrderStatus] ?? h.from_status} → ${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}`
                      : `建立訂單（${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}）`}
                    {h.note && <span className="text-orange-600"> · {h.note}</span>}
                  </li>
                ))}
                {hist && hist.length === 0 && <li className="text-xs text-ink-400">尚無履歴</li>}
                {!hist && <li className="text-xs text-ink-400">載入中…</li>}
              </ol>
            )}
          </div>
        )
      })}

      {/* ===== 二段確認 Modal（危險動作＋原因輸入） ===== */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 anim-pop-in"
          role="dialog" aria-modal="true" aria-label={`${confirming.label}確認`}
          onClick={() => { setConfirming(null); setReason('') }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-ink-900">
              {confirming.danger ? '⚠️ 請再次確認' : '確認操作'}
            </h2>
            <p className="mt-1.5 text-sm text-ink-600 leading-relaxed">
              將把訂單 <span className="font-bold tabular-nums">{confirming.order.order_no}</span>
              （{confirming.order.product_name_snapshot} × {confirming.order.quantity}，
              {fmtMoney(Number(confirming.order.total_amount))}）<br />
              從「{ORDER_STATUS_LABEL[confirming.order.status]}」變更為「{ORDER_STATUS_LABEL[confirming.to]}」。
            </p>
            {confirming.needsReason && (
              <>
                <label htmlFor="reason-input" className="mt-3 block text-sm font-semibold text-ink-700">
                  原因<span className="text-red-500">*</span>（會記錄在訂單與匯出報表）
                </label>
                <textarea
                  id="reason-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  autoFocus
                  maxLength={200}
                  placeholder={
                    confirming.to === 'cancelled'
                      ? '例：客人重複下單、買錯規格…'
                      : '例：客人反映尺寸不合，申請退貨…'
                  }
                  className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2.5 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus:border-accent-400"
                />
              </>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { setConfirming(null); setReason('') }}
                className="flex-1 h-12 rounded-xl border border-ink-200 text-base font-semibold text-ink-600 active:scale-[0.98] transition"
              >
                取消
              </button>
              <button
                onClick={() => void transition(confirming.order, confirming.to, confirming.needsReason ? reason : undefined)}
                disabled={busyId === confirming.order.id || (confirming.needsReason && reason.trim() === '')}
                className={`flex-1 h-12 rounded-xl text-base font-bold active:scale-[0.98] transition disabled:opacity-50 ${
                  confirming.danger ? 'bg-red-500 text-white' : 'bg-ink-900 text-white'
                }`}
              >
                {busyId === confirming.order.id ? '處理中…' : confirming.label.replace(/^\S+\s/, '') + ' ✓'}
              </button>
            </div>
            {confirming.danger && confirming.needsReason && (
              <p className="mt-2 text-center text-xs text-ink-400">取消後庫存將自動回補，此操作不可復原</p>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
