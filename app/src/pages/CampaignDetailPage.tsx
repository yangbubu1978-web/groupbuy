import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign, Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatCountdown } from '../lib/pricing'
import { useLivePrice } from '../lib/useLivePrice'
import { useSharedClock } from '../lib/sharedClock'

/** 活動內的商品卡片（各自訂閱即時價格＋關注數） */
function ProductCard({ product, followers = 0 }: { product: Product; followers?: number }) {
  const live = useLivePrice(product)
  const paused = product.status !== 'active'

  return (
    <Link
      to={`/product/${product.id}`}
      className={`block bg-white rounded-2xl border border-ink-100 shadow-sm overflow-hidden
                  active:scale-[0.99] transition ${paused ? 'opacity-60' : ''}`}
    >
      {/* 圖片 */}
      <div className="aspect-square bg-ink-100 flex items-center justify-center overflow-hidden relative">
        {product.image_url ? (
          <img src={product.image_url} alt={product.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = "hidden" }} className="w-full h-full object-cover" />
        ) : (
          <span className="text-4xl opacity-20">🎁</span>
        )}
        {/* 關注人數徽章 */}
        {followers > 0 && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/55 backdrop-blur
                           px-2.5 py-1 text-[12px] font-semibold text-white">
            ❤️ {followers}
          </span>
        )}
      </div>

      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-ink-900 font-display">{product.name}</h3>
          {paused && (
            <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">
              已暫停
            </span>
          )}
        </div>

        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-wide text-ink-500 mb-1">現在價格</div>
            <div className="text-2xl font-extrabold text-ink-900 tracking-tight tabular-nums leading-none">
              {fmtMoney(live.price)}
            </div>
          </div>
          <div className="text-right text-xs text-ink-500 tabular-nums">
            <div>下一次降價 {formatCountdown(live.nextDropIn)}</div>
            <div className={live.stock <= 3 ? 'text-red-600 font-semibold' : ''}>
              剩餘 {live.stock} 件
            </div>
          </div>
        </div>
        {/* 價格區間 — 與首頁卡一致：起始價 → 底價 一起呈現（雅布指定 2026-09-15） */}
        {(() => {
          const original = Number(product.original_price)
          const minimum = Math.min(Number(product.minimum_price ?? original), original)
          const hasRange = Number.isFinite(minimum) && minimum < original
          if (!hasRange || live.stock <= 0) return null
          const atFloor = live.price <= minimum
          const floorDropped = Math.max(0, original - live.price)
          const floorMaxSave = Math.max(0, live.price - minimum)
          return (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-emerald-50/70 border border-emerald-100 px-3 py-2">
              <span className="flex items-baseline gap-1.5 whitespace-nowrap">
                {floorDropped > 0 && (
                  <>
                    <span className="text-[13px] font-semibold text-ink-500">起始價</span>
                    <span className="text-[15px] font-bold text-ink-500 tabular-nums line-through decoration-ink-300">{fmtMoney(original)}</span>
                    <span className="text-[14px] text-ink-400" aria-hidden="true">→</span>
                  </>
                )}
                {atFloor ? (
                  <span className="text-[14px] font-extrabold text-emerald-700">✅ 最低價 {fmtMoney(minimum)}</span>
                ) : (
                  <>
                    <span className="text-[13px] font-bold text-ink-700">🔒 底價</span>
                    <span className="text-[16px] font-extrabold text-ink-900 tabular-nums">{fmtMoney(minimum)}</span>
                  </>
                )}
              </span>
              {!atFloor && floorMaxSave > 0 && (
                <span className="shrink-0 text-[13px] font-bold text-emerald-700 tabular-nums whitespace-nowrap">
                  還可省 {fmtMoney(floorMaxSave)}
                </span>
              )}
            </div>
          )
        })()}

        <div className="mt-3 h-1.5 rounded-full bg-ink-100 overflow-hidden">
          <div
            className={`h-full rounded-full ${live.stock <= 3 ? 'bg-red-500' : 'bg-accent-500'}`}
            style={{
              width: `${Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))}%`,
            }}
          />
        </div>
      </div>
    </Link>
  )
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', scheduled: '已排程', active: '進行中',
  ended: '已結束', cancelled: '已取消',
}

export default function CampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const navigate = useNavigate()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [followMap, setFollowMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: c } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId ?? '')
        .maybeSingle()
      if (!alive) return
      if (c) {
        setCampaign(c as Campaign)
        const { data: ps } = await supabase
          .from('products')
          .select('id, campaign_id, name, image_url, sku, original_price, minimum_price, price_interval_seconds, price_decrease, price_decrease_max, initial_stock, stock, max_per_customer, status, sale_start_at, forced_delist_at, created_at')
          .eq('campaign_id', campaignId ?? '')
          .order('created_at', { ascending: true })
        if (alive && ps) {
          const list = (ps as Product[]).filter((p: Product) => p.stock > 0)
          setProducts(list)
          const ids = list.map((p: Product) => p.id)
          if (alive && ids.length > 0) {
            const { data: counts } = await supabase.rpc('product_follower_counts_by_ids', { p_ids: ids })
            if (alive) {
              const map: Record<string, number> = {}
              for (const row of (counts ?? []) as { product_id: string; follower_count: number }[]) {
                map[row.product_id] = Number(row.follower_count)
              }
              setFollowMap(map)
            }
          }
        }
      }
      if (alive) setLoading(false)
    })()
    return () => { alive = false }
  }, [campaignId])

  // Hooks 必須在所有條件式 return 之前呼叫，避免載入完成後順序改變。
  // 活動倒數使用共用時鐘，不再自己每秒數秒。
  const clock = useSharedClock()
  const nowMs = clock.nowMs + clock.offsetMs

  if (loading) {
    return (
      <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
        <p className="text-sm text-ink-500">載入中…</p>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="min-h-dvh bg-ink-50 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-ink-500">找不到此活動</p>
        <Link to="/" className="text-sm font-medium text-accent-600">回到活動列表</Link>
      </div>
    )
  }

  const isActive = campaign.status === 'active'

  // 距活動結束的即時倒數（每秒更新）
  const msLeft = new Date(campaign.end_at).getTime() - nowMs
  const endedYet = msLeft <= 0
  const dLeft = Math.floor(msLeft / 86400000)
  const hLeft = Math.floor((msLeft % 86400000) / 3600000)
  const mLeft = Math.floor((msLeft % 3600000) / 60000)
  const sLeft = Math.floor((msLeft % 60000) / 1000)
  const countdownText = endedYet
    ? '已結束'
    : dLeft > 0
      ? `${dLeft} 天 ${hLeft} 小時`
      : `${String(hLeft).padStart(2, '0')}:${String(mLeft).padStart(2, '0')}:${String(sLeft).padStart(2, '0')}`

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white border-b border-ink-100 px-4 py-3 sticky top-0 z-10">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-600"
            aria-label="返回"
          >
            ←
          </button>
          <div className="text-[13px] tracking-wide text-ink-600 font-semibold">⚡ 先買先贏</div>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-5 space-y-4">
        {/* 活動資訊 */}
        <section className="bg-white rounded-2xl border border-ink-100 p-5 shadow-sm anim-fade-up">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-xl font-bold text-ink-900 font-display">{campaign.name}</h1>
            <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${
              isActive ? 'bg-green-50 text-green-700' : 'bg-ink-100 text-ink-500'
            }`}>
              {STATUS_LABEL[campaign.status]}
            </span>
          </div>
          {campaign.description && (
            <p className="mt-1.5 text-sm text-ink-500 leading-relaxed">{campaign.description}</p>
          )}

          {isActive && !endedYet && (
            <div className="mt-4 flex items-center justify-between rounded-xl bg-gradient-to-r
                            from-accent-50 to-accent-100 border border-accent-200 px-4 py-3">
              <span className="text-xs font-medium text-accent-700">⏰ 距活動結束</span>
              <span className="text-base font-bold text-accent-800 tabular-nums">{countdownText}</span>
            </div>
          )}
          {!isActive && (
            <p className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-4 py-2.5 text-xs text-amber-700">
              {campaign.status === 'draft' || campaign.status === 'scheduled'
                ? '活動尚未開始，開始後價格才會啟動降價。'
                : '活動已結束或取消，僅供瀏覽。'}
            </p>
          )}
        </section>

        {/* 商品列表 */}
        <section className="space-y-4">
          {products.map((p) => <ProductCard key={p.id} product={p} followers={followMap[p.id] ?? 0} />)}
          {products.length === 0 && (
            <p className="text-center text-sm text-ink-500 py-12">
              此活動尚無商品
            </p>
          )}
        </section>
      </main>
    </div>
  )
}
