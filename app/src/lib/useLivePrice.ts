import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import {
  computeCurrentPrice,
  secondsToNextDrop,
} from './pricing'
import type { Product } from './types'

export interface LivePriceState {
  price: number
  nextDropIn: number
  serverOffsetMs: number
}

/**
 * 即時價格 Hook
 * - 以 server_now() RPC 校準時鐘（serverOffsetMs）
 * - 每秒重算價格與倒數（純 UI；成交以 Server 為準）
 * - 訂閱 products Realtime → 庫存變動即時更新
 */
export function useLivePrice(product: Product | null) {
  const [state, setState] = useState<LivePriceState>(() => ({
    // 初始即為原價（避免商品未載入時顯示 $0）
    price: product ? Number(product.original_price) : 0,
    nextDropIn: product?.price_interval_seconds ?? 0,
    serverOffsetMs: 0,
  }))
  const [stock, setStock] = useState<number>(product?.stock ?? 0)
  const offsetRef = useRef(0)

  // 商品非同步載入完成後，把庫存同步進來
  // （useState 初始值只在首個 render 生效；ProductPage 的 product 是先 null 後載入）
  useEffect(() => {
    if (product && typeof product.stock === 'number') setStock(product.stock)
  }, [product])

  // 時鐘校準（每 5 分鐘一次）
  useEffect(() => {
    let alive = true
    const sync = async () => {
      const t0 = Date.now()
      const { data } = await supabase.rpc('server_now')
      if (data && alive) {
        const rtt = Date.now() - t0
        offsetRef.current = new Date(data).getTime() + rtt / 2 - Date.now()
        setState((s) => ({ ...s, serverOffsetMs: offsetRef.current }))
      }
    }
    sync()
    const id = setInterval(sync, 5 * 60 * 1000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // 每秒重算顯示價格
  useEffect(() => {
    if (!product) return
    const tick = () => {
      // sale_start_at 空的備援：用 created_at；再沒有就不降價（恆原價）
      const startMs = new Date(product.sale_start_at ?? product.created_at ?? '').getTime()
      if (Number.isNaN(startMs)) {
        setState({
          price: Number(product.original_price),
          nextDropIn: product.price_interval_seconds,
          serverOffsetMs: offsetRef.current,
        })
        return
      }
      const now = Date.now() + offsetRef.current
      const elapsed = Math.max(0, (now - startMs) / 1000)
      const cfg = {
        originalPrice: Number(product.original_price),
        minimumPrice: Number(product.minimum_price),
        priceIntervalSeconds: product.price_interval_seconds,
        priceDecrease: Number(product.price_decrease),
        priceDecreaseMax:
          product.price_decrease_max != null ? Number(product.price_decrease_max) : null,
      }
      setState({
        price: computeCurrentPrice(cfg, elapsed, product.id),
        nextDropIn: secondsToNextDrop(cfg, elapsed),
        serverOffsetMs: offsetRef.current,
      })
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [product])

  // Realtime：庫存即時更新
  useEffect(() => {
    if (!product) return
    const channel = supabase
      .channel(`product-${product.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'products',
          filter: `id=eq.${product.id}`,
        },
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
