import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { useLivePrice } from '../lib/useLivePrice'
import { formatCountdown } from '../lib/pricing'

/** 倒數徽章：距離下次降價的時間（活潑感來源） */
function DropTimer({ seconds }: { seconds: number }) {
  if (seconds <= 0) return null
  const urgent = seconds < 3600
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm font-bold tabular-nums ${
        urgent ? 'bg-red-600 text-white' : 'bg-accent-50 text-accent-700 border border-accent-200'
      }`}
    >
      ⏰ {formatCountdown(seconds)} 後再降
    </span>
  )
}

/** 首頁大圖商品卡 v2：照片為主視覺＋降價倒數＋庫存溫度。promo 非空＝促銷商品 */
function ProductShowcaseCard({ product, index, promo, upcoming, followCount = 0 }: {
  product: Product; index: number; promo?: { name: string; ends_at: string } | null
  upcoming?: boolean; followCount?: number
}) {
  const live = useLivePrice(product)
  const promoRemaining = promo ? Math.max(0, (new Date(promo.ends_at).getTime() - Date.now()) / 1000) : 0
  const original = Number(product.original_price)
  // 即將開賣（開賣時間在未來）→ 鎖定卡：顯示「距開賣」倒數，不顯示降價、不可點
  const isUpcoming = upcoming === true
  const [saleRemain, setSaleRemain] = useState(isUpcoming && product.sale_start_at
    ? Math.max(0, (new Date(product.sale_start_at).getTime() - Date.now()) / 1000)
    : 0)
  useEffect(() => {
    if (!isUpcoming || !product.sale_start_at) return
    const id = setInterval(
      () => setSaleRemain(Math.max(0, (new Date(product.sale_start_at!).getTime() - Date.now()) / 1000)),
      1000,
    )
    return () => clearInterval(id)
  }, [isUpcoming, product.sale_start_at])

  if (isUpcoming) {
    return (
      <div
        className="group block bg-white rounded-2xl border border-ink-200 opacity-80 overflow-hidden active:scale-[0.99] anim-fade-up"
        style={{ animationDelay: `${Math.min(index * 60, 300)}ms` }}
      >
        {/* 大幅照片（1:1） */}
        <div className="aspect-square bg-ink-100 flex items-center justify-center overflow-hidden relative">
          {product.image_url ? (
            <img src={product.image_url} alt={product.name} loading={index > 1 ? 'lazy' : undefined}
              className="w-full h-full object-cover" />
          ) : (
            <span className="text-6xl opacity-20">🎁</span>
          )}
          <span className="absolute top-3 left-3 rounded-lg bg-ink-800 text-white px-3 py-1.5 text-sm font-bold shadow-md">
            🔒 即將開賣
          </span>
          {followCount > 0 && (
            <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-pink-600 shadow-sm">
              ♥ {followCount}
            </span>
          )}
        </div>
        <div className="p-4">
          <h3 className="font-bold text-ink-900 leading-snug line-clamp-2">{product.name}</h3>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-base font-extrabold text-ink-500">$</span>
            <span className="text-2xl font-extrabold text-ink-700 tracking-tight tabular-nums leading-none">{fmtMoney(original)}</span>
          </div>
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 rounded-lg bg-ink-100 text-ink-700 px-3 py-1 text-xs font-bold tabular-nums">
              ⏳ {formatCountdown(saleRemain)} 後開賣
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-500">尚未開賣，敬請期待</p>
        </div>
      </div>
    )
  }

  const dropped = Math.max(0, original - live.price)
  const dropPct = original > 0 ? Math.round((dropped / original) * 100) : 0
  const stockPct = Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))
  const soldOut = live.stock <= 0

  return (
    <Link
      to={`/product/${product.id}`}
      className={`group block bg-white rounded-2xl border shadow-sm overflow-hidden
                  active:scale-[0.99] hover:shadow-lg hover:-translate-y-0.5
                  transition-all duration-200 will-change-transform anim-fade-up ${
                    soldOut ? 'opacity-60' : ''
                  } ${promo ? 'border-accent-300 ring-2 ring-accent-100 shadow-accent-200/40 shadow-lg' : 'border-ink-100'}`}
      style={{ animationDelay: `${Math.min(index * 60, 300)}ms` }}
    >
      {/* 限時促銷帶（促銷商品專屬） */}
      {promo && (
        <div className="bg-gradient-to-r from-accent-500 to-accent-600 text-white px-4 py-2.5
                        flex items-center justify-between gap-3">
          <span className="text-sm font-bold truncate">🏷️ 限時促銷 · {promo.name}</span>
          {promoRemaining > 0 && (
            <span className="shrink-0 text-sm font-bold tabular-nums">⏰ 剩 {formatCountdown(promoRemaining)}</span>
          )}
        </div>
      )}

      {/* 大幅照片（1:1） */}
      <div className="aspect-square bg-ink-100 flex items-center justify-center overflow-hidden relative">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading={index > 1 ? 'lazy' : undefined}
            className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-500 ease-out"
          />
        ) : (
          <span className="text-6xl opacity-20">🎁</span>
        )}
        {dropped > 0 && (
          <span className="absolute top-3 left-3 rounded-lg bg-accent-500 text-white
                           px-3 py-1.5 text-sm font-bold shadow-md anim-pop-in">
            已降 {dropPct}%
          </span>
        )}
        {soldOut && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/45
                                  text-white text-xl font-extrabold tracking-widest">已完售</span>
                )}
                {followCount > 0 && !soldOut && (
                  <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-pink-600 shadow-sm">
                    ♥ {followCount}
                  </span>
                )}
              </div>

      <div className="p-4">
        <h3 className="font-bold text-ink-900 leading-snug line-clamp-2">{product.name}</h3>

        {/* 降價倒數（活潑重點） */}
        {!soldOut && live.nextDropIn > 0 && (
          <div className="mt-2">
            <DropTimer seconds={live.nextDropIn} />
          </div>
        )}
        <div className="mt-2 flex items-end justify-between gap-2">
          <div className="min-w-0 flex items-baseline gap-1.5 flex-wrap">
            <span className="text-base font-extrabold text-accent-600">$</span>
            <span className="text-2xl font-extrabold text-accent-600 tracking-tight tabular-nums leading-none">
              {fmtMoney(live.price)}
            </span>
            <span className="text-sm text-ink-500 line-through">{fmtMoney(original)}</span>
          </div>
        </div>
        {dropped > 0 && (
          <p className="mt-1 text-sm font-bold text-red-600">
            🔥 已省 {fmtMoney(dropped)}，再不搶就沒了
          </p>
        )}

        {/* 庫存進度條＋文案 */}
        <div className="mt-3 h-2 rounded-full bg-ink-100 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ease-out ${
              soldOut ? 'bg-ink-300' : live.stock <= 3 ? 'bg-red-500' : 'bg-gradient-to-r from-accent-400 to-accent-600'
            }`}
            style={{ width: `${soldOut ? 100 : stockPct}%` }}
          />
        </div>
        <p className="mt-1.5 text-sm text-ink-600">
          {soldOut ? '已售完' : live.stock <= 3 ? `僅剩 ${live.stock} 件，手刀搶購！` : `剩 ${live.stock} 件`}
        </p>

        {/* 明確購買入口（整卡可點，但提供看得出的 CTA） */}
        <div className="mt-4 h-12 rounded-xl bg-ink-900 text-white text-base font-bold
                        flex items-center justify-center gap-1.5 active:scale-[0.98] transition">
          {soldOut ? '查看商品' : '查看商品 →'}
        </div>
      </div>
    </Link>
  )
}

export default ProductShowcaseCard
