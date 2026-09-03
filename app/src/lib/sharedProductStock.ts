import { useEffect, useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import type { Product } from './types'

const stocks = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
let channel: ReturnType<typeof supabase.channel> | null = null
let subscriberCount = 0

function notify(productId: string) {
  listeners.get(productId)?.forEach((listener) => listener())
}

function startChannel() {
  if (channel) return
  channel = supabase
    .channel('shared-product-stock')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'products' },
      (payload) => {
        const product = payload.new as Partial<Product> & { id?: string }
        if (!product.id || typeof product.stock !== 'number') return
        stocks.set(product.id, product.stock)
        notify(product.id)
      },
    )
    .subscribe()
}

function stopChannel() {
  if (subscriberCount > 0 || !channel) return
  void supabase.removeChannel(channel)
  channel = null
}

function subscribe(productId: string, listener: () => void) {
  let productListeners = listeners.get(productId)
  if (!productListeners) {
    productListeners = new Set()
    listeners.set(productId, productListeners)
  }
  productListeners.add(listener)
  subscriberCount += 1
  startChannel()

  return () => {
    productListeners?.delete(listener)
    if (productListeners?.size === 0) listeners.delete(productId)
    subscriberCount -= 1
    stopChannel()
  }
}

function getSnapshot(product: Product | null) {
  if (!product) return 0
  return stocks.get(product.id) ?? product.stock
}

export function useSharedProductStock(product: Product | null) {
  useEffect(() => {
    if (!product) return
    stocks.set(product.id, product.stock)
  }, [product])

  return useSyncExternalStore(
    (listener) => product ? subscribe(product.id, listener) : () => {},
    () => getSnapshot(product),
    () => getSnapshot(product),
  )
}
