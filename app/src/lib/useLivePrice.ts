import {
  computeCurrentPrice,
  secondsToNextDrop,
} from './pricing'
import type { Product } from './types'
import { useSharedClock } from './sharedClock'
import { useSharedProductStock } from './sharedProductStock'

export interface LivePriceState {
  price: number
  nextDropIn: number
  serverOffsetMs: number
}

/**
 * 即時價格 Hook
 * - 所有商品共用一個 server clock 與每秒 ticker
 * - 所有商品共用一個 products Realtime channel
 * - 價格直接在算圖時推導，不再用 effect 同步，避免多一次更新
 */
export function useLivePrice(product: Product | null) {
  const clock = useSharedClock()
  const sharedStock = useSharedProductStock(product)

  if (!product) {
    return { price: 0, nextDropIn: 0, serverOffsetMs: clock.offsetMs, stock: sharedStock }
  }

  const startMs = new Date(product.sale_start_at ?? product.created_at ?? '').getTime()
  if (Number.isNaN(startMs)) {
    return {
      price: Number(product.original_price),
      nextDropIn: product.price_interval_seconds,
      serverOffsetMs: clock.offsetMs,
      stock: sharedStock,
    }
  }

  const elapsed = Math.max(0, (clock.nowMs + clock.offsetMs - startMs) / 1000)
  const cfg = {
    originalPrice: Number(product.original_price),
    minimumPrice: Number(product.minimum_price),
    priceIntervalSeconds: product.price_interval_seconds,
    priceDecrease: Number(product.price_decrease),
    priceDecreaseMax: product.price_decrease_max != null ? Number(product.price_decrease_max) : null,
  }

  return {
    price: computeCurrentPrice(cfg, elapsed, product.id),
    nextDropIn: secondsToNextDrop(cfg, elapsed),
    serverOffsetMs: clock.offsetMs,
    stock: sharedStock,
  }
}
