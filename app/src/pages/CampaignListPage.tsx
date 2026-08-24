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
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)

  // 直接載入所有可販售商品（不再分活動層級）
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await supabase
        .from('products')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
      if (alive && data) setProducts(data as Product[])
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

        {loading && (
          <div className="space-y-5">
            <CardSkeleton />
          </div>
        )}
        {!loading && products.length === 0 && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🛍️</div>
            <p className="text-sm text-ink-400">目前沒有進行中的團購商品</p>
          </div>
        )}
        {!loading && products.length > 0 && (
          <>
            {/* 區塊標題：限時好物（電商風左對齊＋橘色標記） */}
            <div className="pt-1 flex items-center gap-2 anim-fade-up">
              <span className="w-1 h-5 rounded-full bg-accent-500" aria-hidden="true" />
              <h3 className="text-lg font-extrabold text-ink-900">限時好物</h3>
              <span className="ml-auto text-[11px] font-semibold text-accent-600">價格越晚越便宜？先搶先贏 →</span>
            </div>
            <div className="space-y-5">
              {products.map((p, i) => <ProductShowcaseCard key={p.id} product={p} index={i} />)}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
