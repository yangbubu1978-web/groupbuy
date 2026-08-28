import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Order, OrderStatus } from '../lib/types'
import { fmtMoney, fmtDateTime } from '../lib/types'
import { ORDER_STATUS_LABEL, ORDER_STATUS_STYLE, ORDER_STATUS_ICON, NEXT_STATUSES } from '../lib/orderStatus'
import { useAuth } from '../context/AuthContext'

type FilterKey = 'all' | OrderStatus
interface HistoryRow { id: string; from_status: string | null; to_status: string; note: string | null; created_at: string }
interface ConfirmState { order: Order; to: OrderStatus; label: string; danger: boolean; needsReason: boolean }
const REASON_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunding', 'refunded'])
const dayStartMs = (s: string): number => new Date(`${s}T00:00:00`).getTime()
const dayEndMs = (s: string): number => new Date(`${s}T23:59:59.999`).getTime()
const POLL_MS = 30_000

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-amber-500', confirmed: 'bg-blue-500', paid: 'bg-emerald-500',
  shipped: 'bg-indigo-500', completed: 'bg-zinc-400', refunding: 'bg-orange-500',
  refunded: 'bg-zinc-300', cancelled: 'bg-red-500',
}

function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${ORDER_STATUS_STYLE[status]} ring-black/5`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status] ?? 'bg-zinc-400'}`} />
      {ORDER_STATUS_ICON[status]} {ORDER_STATUS_LABEL[status]}
    </span>
  )
}

export default function AdminOrdersPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Map<string, { name: string; phone: string }>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [keyword, setKeyword] = useState('')
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  const [reason, setReason] = useState('')
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({})
  const [exportValidOnly, setExportValidOnly] = useState(true)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const prevPendingRef = useRef<number | null>(null)
  const [newOrderAlert, setNewOrderAlert] = useState(false)

  useEffect(() => { if (!authLoading && !isAdmin) navigate('/', { replace: true }) }, [authLoading, isAdmin, navigate])

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
        const n = next.filter((o) => o.status === 'pending').length
        if (prevPendingRef.current !== null && n > prevPendingRef.current) setNewOrderAlert(true)
        prevPendingRef.current = n
        setOrders(next)
      }
      if (custs) setCustomers(new Map(custs.map((c) => [c.auth_user_id ?? '', { name: c.name, phone: c.phone }])) )
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '載入失敗，請檢查網路後重試')
    } finally { setLoading(false) }
  }
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [])
  useEffect(() => {
    let timer: number | undefined
    timer = window.setInterval(() => { if (!document.hidden) void load(true) }, POLL_MS)
    const onVis = () => { if (!document.hidden) void load(true) }
    document.addEventListener('visibilitychange', onVis)
    return () => { if (timer !== undefined) window.clearInterval(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  const transition = async (o: Order, next: OrderStatus, why?: string) => {
    setBusyId(o.id)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      const fnBase = import.meta.env.VITE_SUPABASE_URL as string
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const resp = await fetch(`${fnBase}/functions/v1/admin`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transitionOrder', orderId: o.id, status: next, reason: why?.trim() || undefined }),
      })
      const res = (await resp.json()) as { ok?: boolean; reason?: string; message?: string }
      if (!resp.ok || !res.ok) throw new Error(res.reason ?? res.message ?? `HTTP ${resp.status}`)
      await load(true)
      setConfirming(null); setReason('')
      setActionMsg({ ok: true, text: `✅ ${o.order_no} → ${ORDER_STATUS_LABEL[next]}` })
    } catch (e) {
      setActionMsg({ ok: false, text: `❌ ${e instanceof Error ? e.message : '操作失敗'}` })
    } finally { setBusyId(null) }
  }

  useEffect(() => { if (!actionMsg) return; const t = window.setTimeout(() => setActionMsg(null), 8000); return () => window.clearTimeout(t) }, [actionMsg])

  const toggleHistory = async (orderId: string) => {
    if (historyFor === orderId) { setHistoryFor(null); return }
    setHistoryFor(orderId)
    if (history[orderId]) return
    const { data, error } = await supabase.from('order_status_history').select('id, from_status, to_status, note, created_at').eq('order_id', orderId).order('created_at', { ascending: true })
    if (!error && data) setHistory((h) => ({ ...h, [orderId]: data as HistoryRow[] }))
    else setHistory((h) => ({ ...h, [orderId]: [] }))
  }

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
        return o.order_no.toLowerCase().includes(kw) || o.product_name_snapshot.toLowerCase().includes(kw) || o.sku_snapshot.toLowerCase().includes(kw) || (c?.name ?? '').toLowerCase().includes(kw) || (!!kwDigits && phoneDigits.includes(kwDigits)) || (!!kwAlt && phoneDigits.includes(kwAlt))
      })
    }
    if (dateFrom) { const from = dayStartMs(dateFrom); list = list.filter((o) => new Date(o.purchased_at).getTime() >= from) }
    if (dateTo) { const to = dayEndMs(dateTo); list = list.filter((o) => new Date(o.purchased_at).getTime() <= to) }
    return list
  }, [orders, filter, keyword, customers, dateFrom, dateTo])

  const filtered = useMemo(() => filter === 'all' ? searched.filter((o) => !['cancelled', 'refunded'].includes(o.status)) : searched, [searched, filter])
  const forTable = filtered

  const stats = useMemo(() => {
    const inScope = (o: Order) => searched.some((s) => s.id === o.id)
    const valid = orders.filter((o) => !['cancelled', 'refunded'].includes(o.status))
    const scopedValid = valid.filter(inScope)
    return {
      total: searched.length,
      revenue: scopedValid.reduce((s, o) => s + Number(o.total_amount), 0),
      needAction: orders.filter((o) => ['pending', 'confirmed', 'paid'].includes(o.status)).length,
      refunding: orders.filter((o) => o.status === 'refunding').length,
    }
  }, [orders, searched])

  const exportXls = async () => {
    setBusyId('__export__')
    try {
      const [{ data: products }] = await Promise.all([supabase.from('products').select('id, sku, item_no, unit, items_per_unit')])
      const prodMap = new Map((products ?? []).map((p: { id: string; sku: string; item_no?: string; unit?: string; items_per_unit?: number }) => [p.id, p]))
      const rows: (string | number)[][] = [[
        '訂單編號', '時間', '客戶姓名', '客戶手機', '商品名稱', '商品品號', 'SKU',
        '銷售單位', '數量(單位)', '單價', '金額', '換算單件總數',
        '狀態', '取消者', '取消/退款原因',
      ]]
      const exportList = (exportValidOnly ? searched.filter((o) => !['cancelled', 'refunded'].includes(o.status)) : searched) as (Order & { user_id: string })[]
      let sumQty = 0, sumAmount = 0, sumUnits = 0
      for (const o of exportList) {
        const p = prodMap.get(o.product_id ?? '')
        const ipu = Math.max(1, Number(p?.items_per_unit ?? 1))
        const c = customers.get(o.user_id)
        sumQty += o.quantity; sumAmount += Number(o.total_amount); sumUnits += o.quantity * ipu
        rows.push([o.order_no, new Date(o.purchased_at).toLocaleString('zh-TW'), c?.name ?? '', c?.phone ?? '', o.product_name_snapshot, p?.item_no ?? '', o.sku_snapshot, p?.unit ?? '件', o.quantity, Number(o.unit_price), Number(o.total_amount), o.quantity * ipu, ORDER_STATUS_LABEL[o.status], o.cancelled_by === 'member' ? '會員' : o.cancelled_by === 'admin' ? '管理員' : '', o.cancel_reason ?? ''])
      }
      rows.push([])
      rows.push(['合計', `${exportList.length} 筆${exportValidOnly ? '（僅有效訂單）' : '（含取消/退款）'}`, '', '', '', '', '', '', sumQty, '', sumAmount, sumUnits])
      const esc = (v: string | number) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const trs = rows.map((r, ri) => {
        const cells = r.map((c) => {
          if (typeof c === 'number') return `<td style="mso-number-format:'0'">${c}</td>`
          if (ri === 0) return `<th style="background:#f3ede0;font-weight:bold">${esc(c)}</th>`
          return `<td style="mso-number-format:'@'">${esc(c)}</td>`
        }).join('')
        return `<tr>${cells}</tr>`
      }).join('')
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" /><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>訂單報表</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table border="1">${trs}</table></body></html>`
      const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `訂單報表_${exportValidOnly ? '有效訂單' : '全部'}_${new Date().toISOString().slice(0, 10)}.xls`; a.click(); URL.revokeObjectURL(url)
    } finally { setBusyId(null) }
  }

  const applyQuickDate = (kind: 'today' | 'last7' | 'thisMonth' | 'lastMonth') => {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const now = new Date()
    if (kind === 'today') { const t = fmt(now); setDateFrom(t); setDateTo(t) }
    else if (kind === 'last7') { const d = new Date(now); d.setDate(d.getDate() - 6); setDateFrom(fmt(d)); setDateTo(fmt(now)) }
    else if (kind === 'thisMonth') { setDateFrom(fmt(new Date(now.getFullYear(), now.getMonth(), 1))); setDateTo(fmt(now)) }
    else { const first = new Date(now.getFullYear(), now.getMonth() - 1, 1); const last = new Date(now.getFullYear(), now.getMonth(), 0); setDateFrom(fmt(first)); setDateTo(fmt(last)) }
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

  const onActionClick = (o: Order, a: { to: OrderStatus; label: string; danger?: boolean }) => {
    if (a.danger || REASON_STATUSES.has(a.to)) {
      setReason(''); setConfirming({ order: o, to: a.to, label: a.label, danger: !!a.danger, needsReason: REASON_STATUSES.has(a.to) })
    } else { void transition(o, a.to) }
  }

  return (
    <div className="space-y-4">
      {/* ── 頁首 ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink-900 flex items-center gap-2">
            訂單管理
            {newOrderAlert && (
              <button onClick={() => { setFilter('pending'); setNewOrderAlert(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="h-7 px-3 rounded-full bg-red-500 text-white text-xs font-bold animate-bounce">🔔 有新訂單！</button>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">查看與匯出成交紀錄 · 共 {orders.length} 筆</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button onClick={exportXls} disabled={busyId === '__export__'}
            className="h-10 px-5 rounded-xl bg-ink-900 text-white text-sm font-bold shadow-sm hover:bg-ink-800 active:scale-[0.98] disabled:opacity-50 transition">
            {busyId === '__export__' ? '匯出中…' : '⬇ 匯出 Excel'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-ink-600 cursor-pointer select-none">
            <input type="checkbox" checked={exportValidOnly} onChange={(e) => setExportValidOnly(e.target.checked)} className="h-3.5 w-3.5 accent-ink-900" />
            僅有效訂單
          </label>
        </div>
      </div>

      {/* ── 統計卡 ── */}
      <section className="grid grid-cols-3 gap-2.5">
        <div className="bg-white rounded-2xl border border-ink-200 p-3.5 text-center shadow-sm">
          <div className="text-xl font-extrabold tabular-nums text-ink-900">{stats.total}</div>
          <div className="mt-0.5 text-xs font-semibold tracking-wide text-ink-400">{hasDateFilter ? '範圍內訂單' : '總訂單'}</div>
        </div>
        <div className="bg-white rounded-2xl border border-accent-200 p-3.5 text-center shadow-sm">
          <div className="text-xl font-extrabold tabular-nums text-accent-600">{fmtMoney(stats.revenue)}</div>
          <div className="mt-0.5 text-xs font-semibold tracking-wide text-ink-400">有效營收</div>
        </div>
        <div className={`rounded-2xl border p-3.5 text-center shadow-sm ${stats.needAction > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-ink-200'}`}>
          <div className={`text-xl font-extrabold tabular-nums ${stats.needAction > 0 ? 'text-amber-700' : 'text-ink-900'}`}>{stats.needAction}</div>
          <div className="mt-0.5 text-xs font-semibold tracking-wide text-ink-400">待處理</div>
        </div>
      </section>

      {actionMsg && (
        <div role="alert" className={`rounded-2xl px-4 py-3 text-sm text-center font-medium border shadow-sm ${actionMsg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
          {actionMsg.text}
        </div>
      )}
      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-center">
          <p className="text-sm text-red-600 font-medium">⚠️ 訂單載入失敗：{loadError}</p>
          <button onClick={() => void load()} className="mt-2 h-10 px-6 rounded-xl bg-red-500 text-white text-sm font-bold">🔄 重新載入</button>
        </div>
      )}

      {/* ── 工具列：搜尋＋日期＋篩選 ── */}
      <div className="bg-white rounded-2xl border border-ink-200 shadow-sm p-3 space-y-3">
        {/* 搜尋 — 更大更易用 */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400">⌕</span>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            inputMode="search"
            placeholder="搜尋：訂單編號／商品／SKU／客戶／手機"
            className="w-full h-12 pl-9 pr-4 rounded-xl border border-ink-200 bg-ink-50/60 text-[15px] placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400 transition"
          />
          {keyword && (
            <button onClick={() => setKeyword('')} className="absolute right-2 top-1/2 -translate-y-1/2 h-7 px-2.5 rounded-full bg-ink-900 text-white text-xs font-bold">清除</button>
          )}
        </div>

        {/* 日期 */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-wide text-ink-600 shrink-0">📅 日期</span>
          <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} aria-label="起始日期"
            className="flex-1 min-w-0 h-10 px-2.5 rounded-xl border border-ink-200 bg-white text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-400" />
          <span className="text-ink-400 shrink-0 text-sm">～</span>
          <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} aria-label="結束日期"
            className="flex-1 min-w-0 h-10 px-2.5 rounded-xl border border-ink-200 bg-white text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-400" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(['today', 'last7', 'thisMonth', 'lastMonth'] as const).map(([k]) => (
            <button key={k} onClick={() => applyQuickDate(k as never)}
              className="h-8 px-3 rounded-full text-xs font-bold bg-ink-50 border border-ink-200 text-ink-600 hover:bg-white hover:border-ink-300 transition">
              {({ today: '今天', last7: '近 7 天', thisMonth: '本月', lastMonth: '上月' } as Record<string, string>)[k]}
            </button>
          ))}
          {hasDateFilter && (
            <button onClick={() => { setDateFrom(''); setDateTo('') }}
              className="h-8 px-3 rounded-full text-xs font-bold border border-red-200 text-red-500 hover:bg-red-50 transition ml-auto">✕ 清除日期</button>
          )}
        </div>

        {/* chips */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
              className={`shrink-0 h-8 px-3.5 rounded-full text-xs font-bold ring-1 ring-inset transition ${filter === f.key ? 'bg-ink-900 text-white ring-ink-900' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-400">顯示 {filtered.length} 筆{keyword || hasDateFilter ? `（已篩選，共 ${orders.length} 筆）` : ''}</div>
      </div>

      {loading && orders.length === 0 && <div className="bg-white rounded-2xl border border-ink-200 p-10 text-center text-sm text-ink-400">載入中…</div>}
      {!loading && !loadError && filtered.length === 0 && <div className="bg-white rounded-2xl border border-dashed border-ink-200 p-10 text-center text-sm text-ink-400">沒有符合條件的訂單</div>}

      {/* ── 桌機：表格 ── */}
      {forTable.length > 0 && (
        <div className="hidden md:block bg-white rounded-2xl border border-ink-200 shadow-sm overflow-hidden">
          <div className="max-h-[68vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-ink-50/90 backdrop-blur border-b border-ink-200">
                <tr className="text-left text-xs font-bold tracking-wide text-ink-500">
                  <th className="px-4 py-3 whitespace-nowrap">訂單 / 時間</th>
                  <th className="px-3 py-3 whitespace-nowrap">客戶</th>
                  <th className="px-3 py-3 whitespace-nowrap">商品</th>
                  <th className="px-3 py-3 whitespace-nowrap text-right">數量 × 單價</th>
                  <th className="px-3 py-3 whitespace-nowrap text-right">小計</th>
                  <th className="px-3 py-3 whitespace-nowrap">狀態</th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {forTable.map((o) => {
                  const c = customers.get(o.user_id)
                  const actions = NEXT_STATUSES[o.status] ?? []
                  const isHistOpen = historyFor === o.id
                  const hist = history[o.id]
                  return (
                    <>
                      <tr key={o.id} className={`group ${isHistOpen ? 'bg-amber-50/40' : 'hover:bg-ink-50/70'} transition`}>
                        <td className="px-4 py-3 align-top">
                          <div className="font-mono text-xs font-bold text-ink-900">{o.order_no}</div>
                          <div className="text-xs text-ink-500 tabular-nums">{fmtDateTime(o.purchased_at)}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="font-semibold text-ink-900 text-sm leading-tight">{c?.name ?? '—'}</div>
                          <div className="text-xs text-ink-500 tabular-nums">{c?.phone ?? '—'}</div>
                        </td>
                        <td className="px-3 py-3 align-top max-w-[20ch]">
                          <div className="font-medium text-ink-900 truncate">{o.product_name_snapshot}</div>
                          <div className="text-xs text-ink-400 font-mono truncate">{o.sku_snapshot}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-right tabular-nums whitespace-nowrap text-ink-700">
                          {o.quantity} × {fmtMoney(Number(o.unit_price))}
                        </td>
                        <td className="px-3 py-3 align-top text-right tabular-nums font-extrabold text-ink-900 whitespace-nowrap">
                          {fmtMoney(Number(o.total_amount))}
                        </td>
                        <td className="px-3 py-3 align-top"><StatusBadge status={o.status} /></td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col items-end gap-1.5">
                            {actions.length > 0 ? (
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {actions.map((a) => (
                                  <button key={a.to} onClick={() => onActionClick(o, a)} disabled={busyId === o.id}
                                    className={`h-7 px-3 rounded-full text-xs font-bold border transition disabled:opacity-50 ${a.danger ? 'bg-white border-red-200 text-red-600 hover:bg-red-50' : 'bg-ink-900 border-ink-900 text-white hover:bg-ink-800'}`}>
                                    {busyId === o.id ? '…' : a.label}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-ink-400">—</span>
                            )}
                            <div className="flex items-center gap-2">
                              <button onClick={() => void toggleHistory(o.id)} aria-expanded={isHistOpen}
                                className="text-xs font-medium text-ink-500 hover:text-ink-700 underline underline-offset-2">
                                {isHistOpen ? '收合履歷 ▲' : '履歷 ▼'}
                              </button>
                              {(o.cancel_reason || o.note) && <span className="text-xs text-orange-600 truncate max-w-[14ch]">{o.note ?? ''} {o.cancel_reason ?? ''}</span>}
                            </div>
                          </div>
                        </td>
                      </tr>
                      {isHistOpen && (
                        <tr>
                          <td colSpan={7} className="bg-amber-50/60 px-4 py-3 border-t border-amber-100">
                            <ol className="space-y-1.5 border-l-2 border-amber-200 pl-3">
                              {(hist ?? []).map((h) => (
                                <li key={h.id} className="text-xs text-ink-600">
                                  <span className="tabular-nums font-medium">{fmtDateTime(h.created_at)}</span>
                                  {' — '}
                                  {h.from_status ? `${ORDER_STATUS_LABEL[h.from_status as OrderStatus] ?? h.from_status} → ${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}` : `建立（${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}）`}
                                  {h.note && <span className="text-orange-600"> · {h.note}</span>}
                                </li>
                              ))}
                              {hist && hist.length === 0 && <li className="text-xs text-ink-400">尚無履歷</li>}
                              {!hist && <li className="text-xs text-ink-400">載入中…</li>}
                            </ol>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 手機：卡片 ── */}
      <div className="md:hidden space-y-3">
        {forTable.map((o) => {
          const c = customers.get(o.user_id)
          const actions = NEXT_STATUSES[o.status] ?? []
          const hist = history[o.id]
          return (
            <div key={o.id} className="bg-white rounded-2xl border border-ink-200 p-4 shadow-sm hover:shadow-md hover:border-ink-300 transition">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-[15px] leading-tight text-ink-900 truncate">{o.product_name_snapshot}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
                    <span className="font-mono font-semibold text-ink-700">{o.order_no}</span>
                    <span>·</span>
                    <span className="tabular-nums">{fmtDateTime(o.purchased_at)}</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-600">👤 {c?.name ?? '—'}　📞 {c?.phone ?? '—'}</div>
                </div>
                <StatusBadge status={o.status} />
              </div>
              <div className="mt-3 flex items-center justify-between rounded-xl bg-ink-50 border border-ink-100 px-3 py-2.5">
                <span className="text-sm tabular-nums text-ink-600">{fmtMoney(Number(o.unit_price))} × {o.quantity}</span>
                <span className="text-sm font-extrabold tabular-nums text-ink-900">{fmtMoney(Number(o.total_amount))}</span>
              </div>
              {(o.cancel_reason || o.note) && (
                <p className="mt-2 text-xs text-orange-600 leading-relaxed">{o.note ? `📝 ${o.note} ` : ''}{o.cancel_reason ?? ''}</p>
              )}
              {actions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {actions.map((a) => (
                    <button key={a.to} onClick={() => onActionClick(o, a)} disabled={busyId === o.id}
                      className={`h-9 px-3.5 rounded-xl text-xs font-bold border transition disabled:opacity-50 ${a.danger ? 'bg-white border-red-200 text-red-600' : 'bg-ink-900 border-ink-900 text-white'}`}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => void toggleHistory(o.id)} aria-expanded={historyFor === o.id}
                className="mt-2 text-xs font-medium text-ink-500 underline underline-offset-2">
                {historyFor === o.id ? '收合履歷 ▲' : '📋 狀態履歷 ▼'}
              </button>
              {historyFor === o.id && (
                <ol className="mt-2 space-y-1.5 border-l-2 border-ink-100 pl-3">
                  {(hist ?? []).map((h) => (
                    <li key={h.id} className="text-xs text-ink-600">
                      <span className="tabular-nums">{fmtDateTime(h.created_at)}</span>
                      {' — '}
                      {h.from_status ? `${ORDER_STATUS_LABEL[h.from_status as OrderStatus] ?? h.from_status} → ${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}` : `建立（${ORDER_STATUS_LABEL[h.to_status as OrderStatus] ?? h.to_status}）`}
                      {h.note && <span className="text-orange-600"> · {h.note}</span>}
                    </li>
                  ))}
                  {hist && hist.length === 0 && <li className="text-xs text-ink-400">尚無履歷</li>}
                  {!hist && <li className="text-xs text-ink-400">載入中…</li>}
                </ol>
              )}
            </div>
          )
        })}
      </div>

      {/* 二段確認 Modal */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" onClick={() => { setConfirming(null); setReason('') }}>
          <div className="w-full max-w-md bg-white rounded-2xl p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-extrabold text-ink-900">{confirming.danger ? '⚠️ 請再次確認' : '確認操作'}</h2>
            <p className="mt-2 text-sm text-ink-600 leading-relaxed">
              將把訂單 <span className="font-bold tabular-nums">{confirming.order.order_no}</span>
              （{confirming.order.product_name_snapshot} × {confirming.order.quantity}，{fmtMoney(Number(confirming.order.total_amount))}）<br />
              從「{ORDER_STATUS_LABEL[confirming.order.status]}」變更為「{ORDER_STATUS_LABEL[confirming.to]}」。
            </p>
            {confirming.needsReason && (
              <>
                <label htmlFor="reason-input" className="mt-3 block text-xs font-bold tracking-wide text-ink-700">原因<span className="text-red-500">*</span>（會記錄在訂單與匯出報表）</label>
                <textarea id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus maxLength={200}
                  placeholder={confirming.to === 'cancelled' ? '例：客人重複下單、買錯規格…' : '例：客人反映尺寸不合，申請退貨…'}
                  className="mt-1.5 w-full rounded-xl border border-ink-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-400" />
              </>
            )}
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setConfirming(null); setReason('') }} className="flex-1 h-11 rounded-xl border border-ink-200 text-sm font-bold text-ink-600">取消</button>
              <button onClick={() => void transition(confirming.order, confirming.to, confirming.needsReason ? reason : undefined)}
                disabled={busyId === confirming.order.id || (confirming.needsReason && reason.trim() === '')}
                className={`flex-1 h-11 rounded-xl text-sm font-bold disabled:opacity-50 ${confirming.danger ? 'bg-red-500 text-white' : 'bg-ink-900 text-white'}`}>
                {busyId === confirming.order.id ? '處理中…' : confirming.label.replace(/^\S+\s/, '') + ' ✓'}
              </button>
            </div>
            {confirming.danger && confirming.needsReason && <p className="mt-2 text-center text-xs text-ink-400">取消後庫存將自動回補，此操作不可復原</p>}
          </div>
        </div>
      )}
    </div>
  )
}
