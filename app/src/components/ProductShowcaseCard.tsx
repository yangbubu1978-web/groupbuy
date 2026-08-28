import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import FollowButton from './FollowButton'
import type { Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { useLivePrice } from '../lib/useLivePrice'
import { formatCountdown } from '../lib/pricing'

/** 倒數徽章：距離下次降價的時間 — Beautiful UI 風：柔和圓角 + 微發光 + 玻璃感 */
function DropTimer({ seconds }: { seconds: number }) {
  if (seconds <= 0) return null
  const urgent = seconds < 3600
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-bold tabular-nums tracking-wide
                  backdrop-blur-md border shadow-sm transition-colors ${
        urgent
          ? 'bg-gradient-to-r from-red-500 to-red-600 text-white border-red-400/30 shadow-red-500/25 shadow-md'
          : 'bg-white/90 text-ink-700 border-ink-200/60 shadow-ink-900/[0.06]'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${urgent ? 'bg-white animate-pulse' : 'bg-emerald-500'}`} aria-hidden />
      {formatCountdown(seconds)} 後再降
    </span>
  )
}

/** 首頁大圖商品卡 v3 — 融合 Beautiful UI / Rare UI / BeUI 美學
 *  - 圓角 2xl → 3xl (28px)、柔和多層陰影、hover 浮起
 *  - 促銷帶：多段漸層 + 內發光 + 玻璃 badge
 *  - 庫存條：現代膠囊進度條 + 微光掃過
 *  - 微動效：hover:-translate-y-1、stagger、圖片視差
 */
export interface PromoTag { name: string; icon?: string | null; kind?: string; sort_order?: number }

function ProductShowcaseCard({ product, index, promo, upcoming, followCount = 0 }: {
  product: Product; index: number
  promo?: PromoTag | PromoTag[] | null
  upcoming?: boolean; followCount?: number
}) {
  const promos: PromoTag[] = Array.isArray(promo) ? promo : promo ? [promo] : []
  const primaryPromo = promos[0] ?? null
  const extraCount = Math.max(0, promos.length - 1)
  const live = useLivePrice(product)
  const original = Number(product.original_price)
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
        className="group relative block bg-white rounded-3xl border border-ink-100 overflow-hidden
                   shadow-[0_2px_16px_rgba(0,0,0,0.04),0_4px_24px_rgba(0,0,0,0.04)]
                   hover:shadow-[0_8px_32px_rgba(0,0,0,0.06),0_12px_40px_rgba(0,0,0,0.05)]
                   hover:-translate-y-1 transition-all duration-300 will-change-transform anim-fade-up"
        style={{ animationDelay: `${Math.min(index * 50, 360)}ms` }}
      >
        {/* 鎖定態：柔和遮罩 + 玻璃徽章 */}
        <div className="aspect-square bg-ink-50 flex items-center justify-center overflow-hidden relative">
          {product.image_url ? (
            <img src={product.image_url} alt={product.name} loading={index > 1 ? 'lazy' : undefined}
              className="w-full h-full object-cover opacity-60 group-hover:scale-[1.02] transition-transform duration-700 ease-out" />
          ) : (
            <span className="text-6xl opacity-20">🎁</span>
          )}
          {/* 柔和漸層遮罩 */}
          <div className="absolute inset-0 bg-gradient-to-t from-white/30 via-transparent to-transparent pointer-events-none" />
          <span className="absolute top-3.5 left-3.5 inline-flex items-center gap-1.5 rounded-full
                           bg-ink-900/90 backdrop-blur-md text-white px-3.5 py-1.5 text-[13px] font-bold shadow-lg border border-white/10">
            <span className="w-1.5 h-1.5 rounded-full bg-white/80" /> 即將開賣
          </span>
          {followCount > 0 && (
            <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full
                             bg-white/90 backdrop-blur-md px-3 py-1 text-xs font-bold text-pink-600 shadow-md border border-pink-100">
              ♥ {followCount}
            </span>
          )}
        </div>
        <div className="p-5">
          <h3 className="font-bold text-[15px] text-ink-900 leading-snug line-clamp-2 tracking-tight">{product.name}</h3>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-sm font-extrabold text-ink-400">$</span>
            <span className="text-[22px] font-extrabold text-ink-600 tracking-tight tabular-nums leading-none">{fmtMoney(original)}</span>
          </div>
          <div className="mt-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-900 text-white px-3.5 py-1.5 text-xs font-bold tabular-nums shadow-sm tracking-wide">
              <span className="w-1 h-1 rounded-full bg-white animate-pulse" />
              {formatCountdown(saleRemain)} 後開賣
            </span>
          </div>
          <p className="mt-2.5 text-[13px] text-ink-400 font-medium">尚未開賣，敬請期待</p>
          <div className="mt-3.5" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <FollowButton productId={product.id} saleStartAt={product.sale_start_at} size="card" />
          </div>
        </div>
      </div>
    )
  }

  const dropped = Math.max(0, original - live.price)
  const dropPct = original > 0 ? Math.round((dropped / original) * 100) : 0
  const stockPct = Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))
  const soldOut = live.stock <= 0
  const endingSoon =
    !!product.forced_delist_at && new Date(product.forced_delist_at).getTime() > Date.now()

  return (
    <Link
      to={`/product/${product.id}`}
      className={`group relative block bg-white rounded-3xl border overflow-hidden
                  shadow-[0_2px_16px_rgba(0,0,0,0.04),0_8px_32px_rgba(0,0,0,0.06)]
                  hover:shadow-[0_8px_32px_rgba(0,0,0,0.08),0_16px_56px_rgba(0,0,0,0.08)]
                  hover:-translate-y-1 active:translate-y-0 active:scale-[0.99]
                  transition-all duration-300 will-change-transform anim-fade-up ${
                    soldOut ? 'opacity-60' : ''
                  } ${primaryPromo ? 'border-accent-200/60 ring-1 ring-accent-100' : 'border-ink-100'}`}
      style={{ animationDelay: `${Math.min(index * 50, 360)}ms` }}
    >
      {/* 促銷帶 — 多段漸層 + 內發光 + 玻璃 +N */}
      {primaryPromo && (
        <div
          className="relative bg-gradient-to-r from-accent-500 via-[#ff6b35] to-accent-600 text-white px-4 py-2.5
                        flex items-center justify-between gap-3 overflow-hidden"
          title={extraCount > 0 ? `${primaryPromo.name} 等 ${promos.length} 項活動` : primaryPromo.name}
        >
          {/* 微光掃過 */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.08] to-transparent pointer-events-none" />
          <span className="relative text-[13px] font-bold tracking-wide truncate flex items-center gap-1.5">
            {primaryPromo.icon ? <span className="text-[15px] leading-none">{primaryPromo.icon}</span> : <span>🏷️</span>}
            {primaryPromo.name}
          </span>
          {extraCount > 0 && (
            <span
              className="relative shrink-0 text-xs font-bold bg-white/20 backdrop-blur-sm border border-white/20 rounded-full px-2.5 py-1"
              aria-label={`另有 ${extraCount} 項活動`}
            >
              +{extraCount}
            </span>
          )}
        </div>
      )}
      {/* 即將結束帶 — Rare UI 風微脈動 */}
      {endingSoon && (
        <div className="relative bg-gradient-to-r from-red-500 via-red-500 to-red-600 text-white px-4 py-2
                        flex items-center justify-between gap-3 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent pointer-events-none" />
          <span className="relative text-[13px] font-bold tracking-wide flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> 即將結束
          </span>
          <span className="relative shrink-0 text-xs font-bold tabular-nums bg-white/15 backdrop-blur-sm rounded-full px-2.5 py-1 border border-white/15">
            {formatCountdown(Math.max(0, (new Date(product.forced_delist_at!).getTime() - Date.now()) / 1000))} 後下架
          </span>
        </div>
      )}

      {/* 大幅照片（1:1）— 圓角容器內 + 底部漸層 + 玻璃徽章 */}
      <div className="aspect-square bg-ink-50 flex items-center justify-center overflow-hidden relative">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading={index > 1 ? 'lazy' : undefined}
            className="w-full h-full object-cover group-hover:scale-[1.05] transition-transform duration-700 ease-out"
          />
        ) : (
          <span className="text-6xl opacity-20">🎁</span>
        )}
        {/* 底部柔和陰影：讓徽章更浮 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/[0.08] via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        {dropped > 0 && !soldOut && (
          <span className="absolute top-3.5 left-3.5 inline-flex items-center gap-1.5 rounded-full
                           bg-white/92 backdrop-blur-md text-red-600
                           px-3 py-1.5 text-xs font-extrabold shadow-lg border border-ink-100 anim-pop-in tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> 已降 {dropPct}%
          </span>
        )}
        {soldOut && (
          <span className="absolute inset-0 flex items-center justify-center bg-ink-900/45 backdrop-blur-[2px]
                                  text-white text-lg font-extrabold tracking-[0.2em]">已完售</span>
        )}
        {followCount > 0 && !soldOut && (
          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full
                           bg-white/90 backdrop-blur-md px-3 py-1 text-xs font-bold text-pink-600 shadow-md border border-pink-100">
            ♥ {followCount}
          </span>
        )}
      </div>

      <div className="p-5">
        <h3 className="font-bold text-[15px] text-ink-900 leading-snug line-clamp-2 tracking-tight">{product.name}</h3>

        {/* 降價倒數 — Beautiful UI pill */}
        {!soldOut && live.nextDropIn > 0 && (
          <div className="mt-3">
            <DropTimer seconds={live.nextDropIn} />
          </div>
        )}
        <div className="mt-3 flex items-end justify-between gap-2">
          <div className="min-w-0 flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-extrabold text-accent-600">$</span>
            <span className="text-[26px] font-extrabold text-accent-600 tracking-tight tabular-nums leading-none">
              {fmtMoney(live.price)}
            </span>
            <span className="text-[13px] text-ink-400 line-through font-medium">{fmtMoney(original)}</span>
          </div>
        </div>
        {dropped > 0 && !soldOut && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-100 px-2.5 py-1 text-xs font-bold text-red-600">
            🔥 已省 {fmtMoney(dropped)}
          </p>
        )}

        {/* 庫存進度條 — BeUI 現代膠囊 + 微光 */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-ink-500 tracking-wide">
              {soldOut ? '已售完' : live.stock <= 3 ? '即將售罄' : '庫存'}
            </span>
            <span className="text-xs font-bold tabular-nums text-ink-600">
              {soldOut ? '0' : `${live.stock}`} / {product.initial_stock}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-ink-100 overflow-hidden p-0.5 shadow-inner">
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-out relative overflow-hidden ${
                soldOut ? 'bg-ink-300' : live.stock <= 3 ? 'bg-gradient-to-r from-red-400 to-red-600 shadow-sm shadow-red-500/20' : 'bg-gradient-to-r from-accent-400 via-accent-500 to-accent-600 shadow-sm shadow-accent-500/20'
              }`}
              style={{ width: `${soldOut ? 100 : stockPct}%` }}
            >
              {/* 微光掃過 — 非 urgent 時顯示 */}
              {!soldOut && stockPct > 15 && (
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent -skew-x-12 animate-[shimmer_1.8s_ease-in-out_infinite] pointer-events-none" />
              )}
            </div>
          </div>
          <p className={`mt-1.5 text-xs font-medium ${soldOut ? 'text-ink-400' : live.stock <= 3 ? 'text-red-600 font-bold' : 'text-ink-500'}`}>
            {soldOut ? '已售完 — 錯過等下次' : live.stock <= 3 ? `僅剩 ${live.stock} 件，手刀搶購！` : `剩 ${live.stock} 件`}
          </p>
        </div>

        {/* CTA — BeUI 深色膠囊，hover 浮起 */}
        <div className="mt-4 h-11 rounded-2xl bg-gradient-to-r from-ink-900 to-ink-800 text-white text-[14px] font-bold
                        flex items-center justify-center gap-1.5 shadow-md shadow-ink-900/10
                        group-hover:shadow-lg group-hover:shadow-ink-900/15 group-hover:from-ink-800 group-hover:to-ink-900
                        active:scale-[0.98] transition-all duration-200 tracking-wide">
          {soldOut ? '查看商品' : '查看商品 →'}
        </div>
      </div>
    </Link>
  )
}

export default ProductShowcaseCard
