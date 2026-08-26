// ============================================================
// 訂單狀態字典 — 全站單一真相來源（後台/前台共用）
// P19：原先 STATUS_LABEL/STYLE 兩頁各寫一份，飄移風險歸零
// ============================================================
import type { OrderStatus } from './types'

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '待確認',
  confirmed: '已確認',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  refunding: '退款處理中',
  refunded: '已退款',
  cancelled: '已取消',
}

export const ORDER_STATUS_STYLE: Record<OrderStatus, string> = {
  pending: 'bg-amber-50 text-amber-700',
  confirmed: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  shipped: 'bg-indigo-50 text-indigo-700',
  completed: 'bg-ink-100 text-ink-600',
  refunding: 'bg-orange-50 text-orange-700',
  refunded: 'bg-ink-100 text-ink-500',
  cancelled: 'bg-red-50 text-red-600',
}

export const ORDER_STATUS_ICON: Record<OrderStatus, string> = {
  pending: '⏳',
  confirmed: '✅',
  paid: '💳',
  shipped: '🚚',
  completed: '📦',
  refunding: '↩️',
  refunded: '💸',
  cancelled: '❌',
}

/**
 * 電商狀態機：每個狀態可前往的下一站
 * ⚠️ 必須與 SQL `admin_transition_order`（20260903_order_lifecycle.sql）一致。
 * 前端此表僅決定「顯示哪些按鈕」；真正的合法性檢查在 DB 端狀態機，
 * 兩者飄移時 DB 會擋下並回 invalid_transition，不會寫壞資料。
 */
export const NEXT_STATUSES: Partial<
  Record<OrderStatus, { to: OrderStatus; label: string; danger?: boolean }[]>
> = {
  pending: [
    { to: 'confirmed', label: '✅ 確認訂單' },
    { to: 'cancelled', label: '❌ 取消（回補庫存）', danger: true },
  ],
  confirmed: [
    { to: 'paid', label: '💳 標記已付款' },
    { to: 'cancelled', label: '❌ 取消（回補庫存）', danger: true },
  ],
  paid: [
    { to: 'shipped', label: '🚚 出貨' },
    { to: 'refunding', label: '↩️ 進入退款', danger: true },
  ],
  shipped: [
    { to: 'completed', label: '📦 完成' },
    { to: 'refunding', label: '↩️ 退貨退款', danger: true },
  ],
  completed: [{ to: 'refunding', label: '↩️ 售後退款', danger: true }],
  refunding: [
    { to: 'refunded', label: '💸 退款完成（回補庫存）', danger: true },
    { to: 'shipped', label: '🚫 退款被拒，恢復出貨' },
  ],
}
