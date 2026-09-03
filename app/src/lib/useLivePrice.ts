import { useEffect, useState } from 'react'
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
 */
export function useLivePrice(product: Product | null) {
  const clock = useSharedClock()
  const sharedStock = useSharedProductStock(product)
  const [state, setState] = useState<LivePriceState>(() => ({
    price: product ? Number(product.original_price) : 0,
    nextDropIn: product?.price_interval_seconds ?? 0,
    serverOffsetMs: 0,
  }))

  useEffect(() => {
    if (!product) return
    const startMs = new Date(product.sale_start_at ?? product.created_at ?? '').getTime()
    if (Number.isNaN(startMs)) {
      setState({
        price: Number(product.original_price),
        nextDropIn: product.price_interval_seconds,
        serverOffsetMs: clock.offsetMs,
      })
      return
    }
    const elapsed = Math.max(0, (clock.nowMs + clock.offsetMs - startMs) / 1000)
    const cfg = {
      originalPrice: Number(product.original_price),
      minimumPrice: Number(product.minimum_price),
      priceIntervalSeconds: product.price_interval_seconds,
      priceDecrease: Number(product.price_decrease),
      priceDecreaseMax: product.price_decrease_max != null ? Number(product.price_decrease_max) : null,
    }
    setState({
      price: computeCurrentPrice(cfg, elapsed, product.id),
      nextDropIn: secondsToNextDrop(cfg, elapsed),
      serverOffsetMs: clock.offsetMs,
    })
  }, [product, clock.nowMs, clock.offsetMs])

  return { ...state, stock: sharedStock }
}
