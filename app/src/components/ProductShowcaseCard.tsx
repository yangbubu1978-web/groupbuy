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
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold tabular-nums ${
        urgent ? 'bg-red-500 text-white' : 'bg-accent-50 text-accent-600 border border-accent-200'
      }`}
    >
      ⏰ {formatCountdown(seconds)} 後再降
    </span>
  )
}

/** 首頁大圖商品卡 v2：照片為主視覺＋降價倒數＋庫存溫度 */
function ProductShowcaseCard({ product, index }: { product: Product; index: number }) {
  const live = useLivePrice(product)
  const original = Number(product.original_price)
  const dropped = Math.max(0, original - live.price)
  const dropPct = original > 0 ? Math.round((dropped / original) * 100) : 0
  const stockPct = Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))
  const soldOut = live.stock <= 0

  return (
    <Link
      to={`/product/${product.id}`}
      className={`group block bg-white rounded-2xl border border-ink-100 shadow-sm overflow-hidden
                  active:scale-[0.99] hover:shadow-lg hover:-translate-y-0.5
                  transition-all duration-200 will-change-transform anim-fade-up ${soldOut ? 'opacity-60' : ''}`}
      style={{ animationDelay: `${Math.min(index * 60, 300)}ms` }}
    >
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
          <span className="absolute top-3 left-3 rounded-md bg-accent-500 text-white
                           px-2.5 py-1 text-[11px] font-bold shadow-md anim-pop-in">
            已降 {dropPct}%
          </span>
        )}
        {soldOut && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40
                           text-white font-bold tracking-widest">已完售</span>
        )}
      </div>

      <div className="p-4">
        <h3 className="font-semibold text-ink-900 leading-snug line-clamp-2">{product.name}</h3>

        {/* 降價倒數（活潑重點） */}
        {!soldOut && live.nextDropIn > 0 && (
          <div className="mt-1.5">
            <DropTimer seconds={live.nextDropIn} />
          </div>
        )}

        <div className="mt-2 flex items-end justify-between gap-2">
          <div className="min-w-0 flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-extrabold text-accent-500">$</span>
            <span className="text-2xl font-extrabold text-accent-500 tracking-tight tabular-nums leading-none">
              {fmtMoney(live.price)}
            </span>
            <span className="text-xs text-ink-400 line-through">{fmtMoney(original)}</span>
          </div>
        </div>
        {dropped > 0 && (
          <p className="mt-1 text-[11px] font-bold text-red-500">
            🔥 已省 {fmtMoney(dropped)}，再不搶就沒了
          </p>
        )}

        {/* 庫存進度條＋文案 */}
        <div className="mt-3 h-1.5 rounded-full bg-ink-100 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ease-out ${
              soldOut ? 'bg-ink-300' : live.stock <= 3 ? 'bg-red-500' : 'bg-gradient-to-r from-accent-400 to-accent-600'
            }`}
            style={{ width: `${soldOut ? 100 : stockPct}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-ink-400">
          {soldOut ? '售完補貨中' : live.stock <= 3 ? `僅剩 ${live.stock} 件，手刀搶購！` : `剩 ${live.stock} 件`}
        </p>
      </div>
    </Link>
  )
}

export default ProductShowcaseCard
