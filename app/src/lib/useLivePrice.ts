import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import {
  computeCurrentPrice,
  secondsToNextDrop,
} from './pricing'
import type { Product } from './types'
import { useSharedClock } from './sharedClock'

export interface LivePriceState {
  price: number
  nextDropIn: number
  serverOffsetMs: number
}

/**
 * 即時價格 Hook
 * - 所有商品共用一個 server clock 與每秒 ticker
 * - 訂閱 products Realtime → 庫存變動即時更新
 */
export function useLivePrice(product: Product | null) {
  const clock = useSharedClock()
  const [state, setState] = useState<LivePriceState>(() => ({
    price: product ? Number(product.original_price) : 0,
    nextDropIn: product?.price_interval_seconds ?? 0,
    serverOffsetMs: 0,
  }))
  const [stock, setStock] = useState<number>(product?.stock ?? 0)

  useEffect(() => {
    if (product && typeof product.stock === 'number') setStock(product.stock)
  }, [product])

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

  useEffect(() => {
    if (!product) return
    const channel = supabase
      .channel(`product-${product.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'products', filter: `id=eq.${product.id}` },
        (payload) => {
          const fresh = payload.new as Partial<Product>
          if (typeof fresh.stock === 'number') setStock(fresh.stock)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [product?.id])

  return { ...state, stock }
}
