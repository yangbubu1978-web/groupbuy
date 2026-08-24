// 資料庫型別與共用工具

export type UserStatus = 'active' | 'inactive' | 'blocked'
export type CampaignStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'cancelled'
export type ProductStatus = 'active' | 'paused' | 'ended'
export type OrderStatus =
  | 'pending' | 'confirmed' | 'paid' | 'shipped' | 'completed'
  | 'refunding' | 'refunded' | 'cancelled'

export interface Company { id: string; name: string; note: string | null; status?: string; created_at?: string }
export interface CustomerGroup { id: string; name: string; company_id: string | null }
export interface Banner {
  id: string
  title: string | null
  image_url: string
  target_url: string | null
  sort_order: number
  is_active: boolean
  created_at?: string
}

export interface Customer {
  id: string
  auth_user_id: string | null
  name: string
  phone: string
  company_id: string
  group_id: string | null
  status: UserStatus
  last_login_at: string | null
  must_change_password?: boolean
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  start_at: string
  end_at: string
  status: CampaignStatus
}

export interface Product {
  id: string
  campaign_id: string
  name: string
  description: string | null
  image_url: string | null
  sku: string
  item_no?: string | null
  original_price: number
  minimum_price: number
  price_interval_seconds: number
  price_decrease: number
  price_decrease_max?: number | null
  initial_stock: number
  stock: number
  max_per_customer: number
  status: ProductStatus
  sale_start_at: string | null
  created_at?: string | null
  unit?: string
  items_per_unit?: number
}

export interface Order {
  id: string
  order_no: string
  user_id: string
  product_name_snapshot: string
  sku_snapshot: string
  unit_price: number
  quantity: number
  total_amount: number
  status: OrderStatus
  purchased_at: string
  cancelled_by?: string | null
  cancel_reason?: string | null
  product_id?: string | null
}

/** 金額顯示：$1,290 */
export function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** ISO 時間 → 本地顯示 */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
