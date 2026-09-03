import { supabase } from './supabase'

export type CheckoutResult = {
  data: { ok?: boolean; order_no?: string; unit_price?: number; quantity?: number; total_amount?: number; reason?: string; idempotent_replay?: boolean } | null
  error: unknown
  retried: boolean
}

/**
 * Checkout 網路異常時安全重試一次。
 * checkout_reservation 以 Reservation 為冪等鍵，因此重試不會建立第二筆訂單。
 */
export async function checkoutWithRetry(reservationId: string): Promise<CheckoutResult> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase.rpc('checkout_reservation', {
      p_reservation_id: reservationId,
    })
    if (!error) return { data: data as CheckoutResult['data'], error: null, retried: attempt > 0 }
    lastError = error
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return { data: null, error: lastError, retried: true }
}
