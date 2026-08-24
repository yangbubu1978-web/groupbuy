import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Product } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import { formatCountdown } from '../lib/pricing'
import BannerCarousel from '../components/BannerCarousel'
import ProductShowcaseCard from '../components/ProductShowcaseCard'

/** 載入中的骨架屏 */
function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-ink-100 shadow-sm overflow-hidden">
      <div className="aspect-square skeleton !rounded-none" />
      <div className="p-4 space-y-2.5">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-6 w-1/2" />
        <div className="skeleton h-1.5 w-full" />
      </div>
    </div>
  )
}

export default function CampaignListPage() {
  const { customer, isAdmin } = useAuth()
  const [promoProducts, setPromoProducts] = useState<Product[]>([])
  const [regularProducts, setRegularProducts] = useState<Product[]>([])
  const [promoInfo, setPromoInfo] = useState<Record<string, { name: string; ends_at: string }>>({})
  const [loading, setLoading] = useState(true)
  type PromoBanner = { id: string; name: string; ends_at: string; _countdown: number | null }
  const [runningPromoBanners, setRunningPromoBanners] = useState<PromoBanner[]>([])
  const [phase, setPhase] = useState<'upcoming' | 'running'>('running')

  // 直接載入所有可販售商品（不再分活動層級）
  useEffect(() => {
    let alive = true
    ;(async () => {
      const nowIso = new Date().toISOString()
      // 進行中的促銷活動（時間窗內＋已啟用）
      const { data: runningPromos } = await supabase
        .from('promotions')
        .select('id, name, ends_at, promotion_items(product_id)')
        .lte('starts_at', nowIso)
        .gte('ends_at', nowIso)
        .eq('is_active', true)
        .eq('status', 'active')

      const { data } = await supabase
        .from('products')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      // 全部 active 商品都陳列；進行中促銷商品 →「限時促銷」專區，其餘 → 一般區
      const all = (data ?? []) as Product[]
      const promoIds = new Set<string>()
      const promoInfoMap: Record<string, { name: string; ends_at: string }> = {}
      for (const promo of runningPromos ?? []) {
        for (const item of (promo.promotion_items ?? []) as { product_id: string }[]) {
          promoIds.add(item.product_id)
          if (!promoInfoMap[item.product_id]) {
            promoInfoMap[item.product_id] = { name: promo.name, ends_at: promo.ends_at }
          }
        }
      }
      if (alive) {
        setPromoProducts(all.filter((p) => promoIds.has(p.id)))
        setRegularProducts(all.filter((p) => !promoIds.has(p.id)))
        setPromoInfo(promoInfoMap)
      }

      // 橫幅：進行中優先，否則即將開始
      const { data: bannerPromos } = await supabase
        .from('promotions')
        .select('id, name, starts_at, ends_at')
        .eq('is_active', true)
        .eq('status', 'active')
        .gte('ends_at', nowIso)
        .order('starts_at', { ascending: true })
      if (alive && bannerPromos) {
        const now = Date.now()
        const mapped = bannerPromos.map((p) => {
          const running = new Date(p.starts_at).getTime() <= now
          return {
            id: p.id, name: p.name, ends_at: p.ends_at,
            _countdown: running ? Math.max(0, (new Date(p.ends_at).getTime() - now) / 1000) : null,
          }
        })
        const runningList = mapped.filter((m) => m._countdown !== null)
        setRunningPromoBanners(runningList.length > 0 ? runningList.slice(0, 2) : mapped.slice(0, 1))
        setPhase(runningList.length > 0 ? 'running' : 'upcoming')
      }
      if (alive) setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  // 問候語：依時段變化
  const hour = new Date().getHours()
  const greeting =
    hour < 11 ? '早安' : hour < 14 ? '午安' : hour < 22 ? '晚安' : '夜深了'

  return (
    <div className="min-h-dvh bg-ink-50 pb-24">
      {/* 頂部：台灣電商風橘色漸層橫幅 */}
      <header className="bg-gradient-to-r from-accent-500 to-accent-600 px-5 py-4 sticky top-0 z-10 shadow-md">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div>
            <div className="text-[11px] tracking-widest text-accent-100 font-semibold">⚡ 先買先贏</div>
            <h1 className="text-lg font-extrabold text-white tracking-wide">吸引力生活好物</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={isAdmin ? '/admin/orders' : '/orders'}
              className="text-xs font-medium px-3 py-1.5 rounded-full border border-white/60 text-white hover:bg-white/15 transition"
            >
              {isAdmin ? '訂單管理' : '我的訂單'}
            </Link>
            <Link
              to="/profile"
              aria-label="我的帳號"
              className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-sm font-bold text-accent-600 shadow-sm"
            >
              {customer?.name?.slice(0, 1) ?? '?'}
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-5 space-y-5">
        {/* 問候區（活潑電商風） */}
        <section className="pt-1 pb-1 anim-fade-up">
          <h2 className="text-[24px] leading-snug font-extrabold text-ink-900">
            {greeting}，{customer?.name} 👋
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            好物正在降價中，手刀搶起來！🔥
          </p>
        </section>

        {/* 首頁廣告看板輪播 */}
        <BannerCarousel />

        {/* 促銷活動橫幅（點入活動商品區） */}
        {runningPromoBanners.length > 0 && (
          <section className="space-y-2" aria-label="促銷活動">
            {runningPromoBanners.map((p, i) => (
              <Link key={p.id} to={`/?promo=${p.id}`}
                className="block rounded-2xl bg-gradient-to-r from-accent-500 to-accent-600
                           text-white px-4 py-3 shadow-md anim-fade-up active:scale-[0.99] transition"
                style={{ animationDelay: `${i * 60}ms` }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold tracking-widest opacity-80">🏷️ 限時促銷</p>
                    <p className="text-sm font-bold truncate">{p.name}</p>
                  </div>
                  {phase === 'running' && p._countdown !== null && (
                    <span className="shrink-0 rounded-full bg-white/20 px-2 py-1 text-[11px] font-bold tabular-nums">
                      ⏰ {formatCountdown(p._countdown)}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </section>
        )}

        {loading && (
          <div className="space-y-5">
            <CardSkeleton />
          </div>
        )}
        {!loading && promoProducts.length === 0 && regularProducts.length === 0 && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🛍️</div>
            <p className="text-sm text-ink-400">目前沒有進行中的團購商品</p>
          </div>
        )}
        {!loading && (promoProducts.length + regularProducts.length) > 0 && (
          <>
            {/* 限時促銷專區（置頂，突顯促銷商品） */}
            {promoProducts.length > 0 && (
              <section className="space-y-4">
                <div className="rounded-2xl overflow-hidden shadow-md anim-fade-up">
                  <div className="bg-gradient-to-r from-accent-500 to-accent-600 px-4 py-3 flex items-center gap-2">
                    <span className="text-xl" aria-hidden="true">🏷️</span>
                    <div>
                      <p className="text-[10px] font-bold tracking-widest text-accent-100">僅限促銷期間</p>
                      <h3 className="text-base font-extrabold text-white leading-tight">限時促銷專區</h3>
                    </div>
                    <span className="ml-auto text-[11px] font-semibold text-white/90">手刀搶購 →</span>
                  </div>
                </div>
                <div className="space-y-5">
                  {promoProducts.map((p, i) => (
                    <ProductShowcaseCard key={p.id} product={p} index={i} promo={promoInfo[p.id] ?? null} />
                  ))}
                </div>
              </section>
            )}
            {/* 一般降價商品區 */}
            {regularProducts.length > 0 && (
              <>
                <div className={`${promoProducts.length > 0 ? 'pt-2' : 'pt-1'} flex items-center gap-2 anim-fade-up`}>
                  <span className="w-1 h-5 rounded-full bg-accent-500" aria-hidden="true" />
                  <h3 className="text-lg font-extrabold text-ink-900">{promoProducts.length > 0 ? '其他好物' : '限時好物'}</h3>
                  <span className="ml-auto text-[11px] font-semibold text-accent-600">價格越晚越便宜？先搶先贏 →</span>
                </div>
                <div className="space-y-5">
                  {regularProducts.map((p, i) => <ProductShowcaseCard key={p.id} product={p} index={i} />)}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
