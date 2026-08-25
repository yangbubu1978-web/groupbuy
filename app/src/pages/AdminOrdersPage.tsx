import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Order } from '../lib/types'
import { fmtMoney, fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'

const STATUS_LABEL: Record<string, string> = {
  pending: '待確認', confirmed: '已確認', paid: '已付款',
  shipped: '已出貨', completed: '已完成', refunding: '退款處理中',
  refunded: '已退款', cancelled: '已取消',
}
const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700', confirmed: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700', shipped: 'bg-indigo-50 text-indigo-700',
  completed: 'bg-ink-100 text-ink-600', refunding: 'bg-orange-50 text-orange-700',
  refunded: 'bg-ink-100 text-ink-500', cancelled: 'bg-red-50 text-red-600',
}

/** 電商狀態機：每個狀態可前往的下一站（與 DB admin_transition_order 一致） */
const NEXT_STATUSES: Record<string, { to: string; label: string }[]> = {
  pending: [
    { to: 'confirmed', label: '✅ 確認訂單' },
    { to: 'cancelled', label: '❌ 取消（回補庫存）' },
  ],
  confirmed: [
    { to: 'paid', label: '💳 標記已付款' },
    { to: 'cancelled', label: '❌ 取消（回補庫存）' },
  ],
  paid: [
    { to: 'shipped', label: '🚚 出貨' },
    { to: 'refunding', label: '↩️ 進入退款' },
  ],
  shipped: [
    { to: 'completed', label: '📦 完成' },
    { to: 'refunding', label: '↩️ 退貨退款' },
  ],
  completed: [{ to: 'refunding', label: '↩️ 售後退款' }],
  refunding: [
    { to: 'refunded', label: '💸 退款完成（回補庫存）' },
    { to: 'shipped', label: '🚫 退款被拒，恢復出貨' },
  ],
}

type FilterKey = 'all' | 'pending' | 'confirmed' | 'paid' | 'shipped' | 'completed' | 'refunding' | 'refunded' | 'cancelled'

export default function AdminOrdersPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [customers, setCustomers] = useState<Map<string, { name: string; phone: string }>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [keyword, setKeyword] = useState('')
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async () => {
    const [{ data }, { data: custs }] = await Promise.all([
      supabase.from('orders').select('*').order('purchased_at', { ascending: false }),
      supabase.from('customers').select('auth_user_id, name, phone'),
    ])
    if (data) setOrders(data as Order[])
    if (custs) setCustomers(new Map(custs.map((c) => [c.auth_user_id ?? '', { name: c.name, phone: c.phone }])))
  }
  useEffect(() => { load() }, [])

  /** 狀態轉移：走 admin Edge Function → SQL 狀態機（含庫存回補） */
  const transition = async (o: Order, next: string) => {
    setBusyId(o.id)
    setActionMsg(null)
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
        body: JSON.stringify({ action: 'transitionOrder', orderId: o.id, status: next }),
      })
      const res = (await resp.json()) as { ok?: boolean; reason?: string; message?: string }
      if (!resp.ok || !res.ok) throw new Error(res.reason ?? res.message ?? `HTTP ${resp.status}`)
      await load()
      setActionMsg(`✅ ${o.order_no} → ${STATUS_LABEL[next]}`)
    } catch (e) {
      setActionMsg(`❌ ${e instanceof Error ? e.message : '操作失敗'}`)
    } finally {
      setBusyId(null)
    }
  }

  // 篩選＋搜尋
  const filtered = useMemo(() => {
    let list = orders
    if (filter !== 'all') list = list.filter((o) => o.status === filter)
    const kw = keyword.trim().toLowerCase()
    if (kw) {
      list = list.filter((o) => {
        const c = customers.get((o as unknown as { user_id: string }).user_id)
        return (
          o.order_no.toLowerCase().includes(kw) ||
          o.product_name_snapshot.toLowerCase().includes(kw) ||
          o.sku_snapshot.toLowerCase().includes(kw) ||
          (c?.name ?? '').toLowerCase().includes(kw) ||
          (c?.phone ?? '').includes(keyword.trim())
        )
      })
    }
    return list
  }, [orders, filter, keyword, customers])

  // 統計卡
  const stats = useMemo(() => {
    const valid = orders.filter((o) => !['cancelled', 'refunded'].includes(o.status))
    return {
      total: orders.length,
      revenue: valid.reduce((s, o) => s + Number(o.total_amount), 0),
      needAction: orders.filter((o) => ['pending', 'paid'].includes(o.status)).length,
      refunding: orders.filter((o) => o.status === 'refunding').length,
    }
  }, [orders])

  // 匯出 Excel（.xls，HTML 表格格式的 Excel 97-2003 相容檔）：
  // 儲存格原生保留文字格式——手機 09 開頭的 0 不會消失、不會變科學記號
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
      let sumQty = 0
      let sumAmount = 0
      for (const o of filtered as (Order & { user_id: string })[]) {
        const p = prodMap.get((o as unknown as { product_id?: string }).product_id ?? '')
        const ipu = Math.max(1, Number(p?.items_per_unit ?? 1))
        const c = customers.get(o.user_id)
        sumQty += o.quantity
        sumAmount += Number(o.total_amount)
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
          STATUS_LABEL[o.status] ?? o.status,
          (o as unknown as { cancelled_by?: string }).cancelled_by === 'member'
            ? '會員'
            : (o as unknown as { cancelled_by?: string }).cancelled_by === 'admin' ? '管理員' : '',
          (o as unknown as { cancel_reason?: string }).cancel_reason ?? '',
        ])
      }
      // 彙總列
      rows.push([])
      rows.push(['合計', `${filtered.length} 筆`, '', '', '', '', '', sumQty, '', sumAmount])

      // HTML <table> 包成 .xls：Excel 97-2003 可直接開啟，儲存格型別由 mso-number-format 控制
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
              return `<td style="mso-number-format:'\@'">${esc(c)}</td>`
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
      a.download = `訂單報表_${new Date().toISOString().slice(0, 10)}.xls`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusyId(null)
    }
  }

  const FILTERS: { key: FilterKey; label: string }[] = [
    { key: 'all', label: `全部 ${orders.length}` },
    { key: 'pending', label: `待確認 ${orders.filter((o) => o.status === 'pending').length}` },
    { key: 'paid', label: `已付款 ${orders.filter((o) => o.status === 'paid').length}` },
    { key: 'shipped', label: `已出貨 ${orders.filter((o) => o.status === 'shipped').length}` },
    { key: 'refunding', label: `退款中 ${stats.refunding}` },
    { key: 'completed', label: '已完成' },
    { key: 'cancelled', label: '已取消' },
  ]

  return (
    <main className="space-y-3">
        {/* 標題列＋匯出 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-ink-900">訂單管理</h1>
            <p className="text-xs md:text-sm text-ink-400">查看與匯出成交紀錄</p>
          </div>
          <button onClick={exportXls}
            className="h-10 px-4 rounded-xl bg-ink-900 text-white text-sm font-semibold active:scale-[0.98] transition">
            ⬇ 匯出 Excel
          </button>
        </div>

        {/* 統計卡 */}
        <section className="grid grid-cols-3 gap-2 anim-fade-up">
          <div className="bg-white rounded-xl border border-ink-100 p-3 text-center shadow-sm">
            <div className="text-lg font-bold text-ink-900 tabular-nums">{stats.total}</div>
            <div className="text-[11px] text-ink-400 mt-0.5">總訂單</div>
          </div>
          <div className="bg-white rounded-xl border border-accent-200 bg-gradient-to-br from-accent-50 to-white p-3 text-center shadow-sm">
            <div className="text-lg font-bold text-accent-600 tabular-nums">{fmtMoney(stats.revenue)}</div>
            <div className="text-[11px] text-ink-400 mt-0.5">有效營收</div>
          </div>
          <div className={`rounded-xl border p-3 text-center shadow-sm ${stats.needAction > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-ink-100'}`}>
            <div className={`text-lg font-bold tabular-nums ${stats.needAction > 0 ? 'text-amber-700' : 'text-ink-900'}`}>
              {stats.needAction}
            </div>
            <div className="text-[11px] text-ink-400 mt-0.5">待處理</div>
          </div>
        </section>

        {/* 操作結果提示 */}
        {actionMsg && (
          <div role="alert" className="rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-xs text-center anim-pop-in shadow-sm">
            {actionMsg}
          </div>
        )}

        {/* 搜尋 */}
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜尋：訂單編號／商品／SKU／客戶／手機"
          className="w-full h-10 px-4 rounded-xl border border-ink-200 bg-white text-sm placeholder:text-ink-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus:border-accent-400"
        />

        {/* 狀態篩選 chips */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`shrink-0 h-8 px-3 rounded-full text-xs font-medium transition ${
                filter === f.key
                  ? 'bg-ink-900 text-white'
                  : 'bg-white border border-ink-200 text-ink-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* 訂單列表 */}
        {filtered.length === 0 && (
          <p className="text-center text-sm text-ink-400 py-12">沒有符合條件的訂單</p>
        )}
        {filtered.map((o) => {
          const c = customers.get((o as unknown as { user_id: string }).user_id)
          const actions = NEXT_STATUSES[o.status] ?? []
          return (
            <div key={o.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink-900">{o.product_name_snapshot}</h3>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {o.order_no} · {fmtDateTime(o.purchased_at)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    👤 {c?.name ?? '—'}　📞 {c?.phone ?? '—'}
                  </p>
                </div>
                <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLE[o.status] ?? ''}`}>
                  {STATUS_LABEL[o.status]}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-ink-500 tabular-nums">
                  {fmtMoney(Number(o.unit_price))} × {o.quantity}
                </span>
                <span className="font-bold text-ink-900 tabular-nums">{fmtMoney(Number(o.total_amount))}</span>
              </div>

              {(o.cancel_reason || (o as unknown as { note?: string }).note) && (
                <p className="mt-1.5 text-[11px] text-orange-600">
                  {(o as unknown as { note?: string }).note ? `📝 ${(o as unknown as { note?: string }).note}` : ''}
                  {o.cancel_reason ? ` ${o.cancel_reason}` : ''}
                </p>
              )}

              {/* 狀態機動作按鈕 */}
              {actions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {actions.map((a) => (
                    <button
                      key={a.to}
                      onClick={() => transition(o, a.to)}
                      disabled={busyId === o.id}
                      className={`h-9 px-3 rounded-xl text-xs font-semibold active:scale-[0.98] transition disabled:opacity-50 ${
                        a.to === 'cancelled' || a.to === 'refunding' || a.to === 'refunded'
                          ? 'border border-red-200 text-red-500'
                          : 'bg-ink-900 text-white'
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </main>
  )
}
