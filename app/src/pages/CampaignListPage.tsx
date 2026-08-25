import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Product } from '../lib/types'
import { useAuth } from '../context/AuthContext'
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
  const [upcomingProducts, setUpcomingProducts] = useState<Product[]>([])
  const [promoInfo, setPromoInfo] = useState<Record<string, { name: string; ends_at: string }>>({})
  const [followMap, setFollowMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

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
      const nowMs = Date.now()
      const isUpcoming = (p: Product) => !!p.sale_start_at && new Date(p.sale_start_at).getTime() > nowMs
      // 各商品追蹤人數（RPC：product_follower_counts）
      const { data: fc } = await supabase.rpc('product_follower_counts')
      const fm: Record<string, number> = {}
      for (const r of (fc ?? []) as { product_id: string; follower_count: number }[]) {
        fm[r.product_id] = Number(r.follower_count)
      }
      if (alive) {
        setPromoProducts(all.filter((p) => promoIds.has(p.id)))
        setUpcomingProducts(all.filter((p) => !promoIds.has(p.id) && isUpcoming(p)))
        setRegularProducts(all.filter((p) => !promoIds.has(p.id) && !isUpcoming(p)))
        setPromoInfo(promoInfoMap)
        setFollowMap(fm)
        setLoading(false)
      }
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
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between">
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

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-5 space-y-5">
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

        {/* 下單規則說明（廣告看板 ↔ 促銷/商品標題之間） */}
        <section className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm anim-fade-up">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm" aria-hidden="true">🛒</span>
            <h3 className="text-sm font-bold text-ink-900">怎麼買最划算？</h3>
          </div>
          <ul className="space-y-1.5 text-xs text-ink-600 leading-relaxed">
            <li>・價格會隨時間 <b className="text-ink-900">自動往下調</b>，每件商品依自己的節奏隨機降價，越晚下手越便宜。</li>
            <li>・<b className="text-ink-900">價格只會越來越低</b>：但庫存有限、先買先贏，錯過就不再回來，猶豫太久會後悔。</li>
          </ul>
          <p className="mt-2 text-xs font-semibold text-accent-600">❤️ 心動就下手，別等到最後一秒！</p>
        </section>

        {loading && (
          <div className="space-y-5">
            <CardSkeleton />
          </div>
        )}
        {!loading && promoProducts.length === 0 && regularProducts.length === 0 && upcomingProducts.length === 0 && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🛍️</div>
            <p className="text-sm text-ink-400">目前沒有進行中的團購商品</p>
          </div>
        )}
        {!loading && (promoProducts.length + regularProducts.length + upcomingProducts.length) > 0 && (
          <>
            {/* 限時促銷專區（置頂，突顯促銷商品） */}
            {promoProducts.length > 0 && (
              <section className="space-y-4">
                <div className="pt-1 flex items-center gap-2 anim-fade-up">
                  <span className="w-1 h-5 rounded-full bg-accent-500" aria-hidden="true" />
                  <h3 className="text-lg font-extrabold text-ink-900">限時促銷</h3>
                  <span className="ml-auto text-[11px] font-semibold text-accent-600">限量優惠，先搶先贏 →</span>
                </div>
                <div className="space-y-5">
                  {promoProducts.map((p, i) => (
                    <ProductShowcaseCard key={p.id} product={p} index={i} promo={promoInfo[p.id] ?? null} followCount={followMap[p.id] ?? 0} />
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
                  {regularProducts.map((p, i) => <ProductShowcaseCard key={p.id} product={p} index={i} followCount={followMap[p.id] ?? 0} />)}
                </div>
              </>
            )}
            {/* 即將開賣（最下方，鎖定展示） */}
            {upcomingProducts.length > 0 && (
              <>
                <div className="pt-2 flex items-center gap-2 anim-fade-up">
                  <span className="w-1 h-5 rounded-full bg-ink-300" aria-hidden="true" />
                  <h3 className="text-lg font-extrabold text-ink-900">即將開賣</h3>
                  <span className="ml-auto text-[11px] font-semibold text-ink-400">Coming Soon</span>
                </div>
                <div className="space-y-5">
                  {upcomingProducts.map((p, i) => (
                    <ProductShowcaseCard key={p.id} product={p} index={i} upcoming followCount={followMap[p.id] ?? 0} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
