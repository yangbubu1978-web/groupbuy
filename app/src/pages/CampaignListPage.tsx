import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Product } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import BannerCarousel from '../components/BannerCarousel'
import ProductShowcaseCard, { type PromoTag } from '../components/ProductShowcaseCard'

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

/** 購物車待結帳數徽章（查 cart_reservations active，Realtime 即時同步） */
function CartBadge() {
  const { userId } = useAuth()
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!userId) return
    let alive = true
    const fetchCount = async () => {
      const { count } = await supabase
        .from('cart_reservations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'active')
      if (alive) setCount(count ?? 0)
    }
    fetchCount()
    const ch = supabase
      .channel(`cart-badge-${userId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cart_reservations', filter: `user_id=eq.${userId}` },
        () => fetchCount())
      .subscribe()
    return () => { alive = false; supabase.removeChannel(ch) }
  }, [userId])

  if (count <= 0) return null
  return (
    <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-red-600 text-white
                     text-xs font-bold flex items-center justify-center border-2 border-white">
      {count > 9 ? '9+' : count}
    </span>
  )
}

export default function CampaignListPage() {
  const { customer, isAdmin } = useAuth()
  const [promoProducts, setPromoProducts] = useState<Product[]>([])
  const [regularProducts, setRegularProducts] = useState<Product[]>([])
  const [upcomingProducts, setUpcomingProducts] = useState<Product[]>([])
  const [promoInfo, setPromoInfo] = useState<Record<string, PromoTag[]>>({})
  const [followMap, setFollowMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [noticeOpen, setNoticeOpen] = useState(false)

  // 直接載入所有可販售商品（不再分活動層級）
  useEffect(() => {
    let alive = true
    ;(async () => {
      const nowIso = new Date().toISOString()
      // 進行中的促銷活動（時間窗內＋已啟用）
      const { data: runningPromos } = await supabase
        .from('promotions')
        .select('id, name, icon, sort_order, ends_at, kind, promotion_items(product_id)')
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
      const nowIso2 = Date.now()
      // 已完售（庫存歸零）直接隱藏，不展示「已完售」卡片
      const all = ((data ?? []) as Product[]).filter(
        (p) => p.stock > 0 && (!p.forced_delist_at || new Date(p.forced_delist_at).getTime() > nowIso2),
      )
      const promoIds = new Set<string>()
      const promoInfoMap: Record<string, PromoTag[]> = {}
      for (const promo of (runningPromos ?? []) as { id: string; name: string; icon?: string | null; kind?: string; sort_order?: number; promotion_items?: { product_id: string }[] }[]) {
        for (const item of (promo.promotion_items ?? []) as { product_id: string }[]) {
          promoIds.add(item.product_id)
          if (!promoInfoMap[item.product_id]) promoInfoMap[item.product_id] = []
          promoInfoMap[item.product_id].push({
            name: promo.name,
            icon: promo.icon,
            kind: promo.kind,
          })
        }
      }
      // 每個商品的活動清單按活動排序（sort_order 小在前）
      for (const k of Object.keys(promoInfoMap)) {
        promoInfoMap[k].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
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

  // Realtime：單件棄單罰則會推 sale_start_at，首頁需即時反映倒數變長
  // + 關注商品開賣時本地通知（Mobile First：關站推播由 pg_cron/Edge 補強）
  useEffect(() => {
    const ch = supabase.channel('products-penalty')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'products' }, async (payload) => {
        const n = payload.new as unknown as { id: string; sale_start_at: string | null; name?: string }
        const patchOne = (prev: Product[]) => prev.map((p) => p.id === n.id ? { ...p, sale_start_at: n.sale_start_at } as Product : p)
        setPromoProducts(patchOne); setRegularProducts(patchOne); setUpcomingProducts(patchOne)
        // 若此商品剛開賣（sale_start_at 變成已過）且用戶有關注，發本地通知
        try {
          const saleAt = n.sale_start_at ? new Date(n.sale_start_at).getTime() : 0
          if (saleAt && saleAt <= Date.now()) {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) return
            const { data: f } = await supabase.from('product_follows').select('product_id').eq('user_id', user.id).eq('product_id', n.id).maybeSingle()
            if (!f) return
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification('🔥 商品已上架！', { body: `${(n as { name?: string }).name ?? '您關注的商品'}已開賣，快去搶購！`, icon: './icons/icon-192.png', tag: `sale-${n.id}` })
            }
          }
        } catch {}
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  // 每 30 秒輕量輪詢：商品被 cron 下架/完售時自動從畫面消失；活動到期時商品降級到一般區
  useEffect(() => {
    const id = setInterval(async () => {
      const ids = [
        ...promoProducts.map((p) => p.id),
        ...regularProducts.map((p) => p.id),
        ...upcomingProducts.map((p) => p.id),
      ]
      if (ids.length === 0) return
      const nowIso = new Date().toISOString()
      const [{ data }, { data: stillRunning }] = await Promise.all([
        supabase.from('products').select('id, status, stock, forced_delist_at').in('id', ids),
        supabase
          .from('promotions')
          .select('id, promotion_items(product_id)')
          .lte('starts_at', nowIso)
          .gte('ends_at', nowIso)
          .eq('is_active', true)
          .eq('status', 'active'),
      ])
      if (!data) return
      const nowMs = Date.now()
      const aliveIds = new Set(
        (data as { id: string; status: string; stock: number; forced_delist_at: string | null }[])
          .filter((x) => x.status === 'active'
            && x.stock > 0
            && (!x.forced_delist_at || new Date(x.forced_delist_at).getTime() > nowMs))
          .map((x) => x.id),
      )
      // 仍在進行中活動的商品集合（活動到期 → 自動降級到一般區）
      const livePromoIds = new Set<string>()
      for (const promo of (stillRunning ?? []) as { promotion_items?: { product_id: string }[] }[]) {
        for (const item of promo.promotion_items ?? []) livePromoIds.add(item.product_id)
      }
      // 只在真的有變化時才更新（避免無謂重渲染）
      const prune = (prev: Product[]) => {
        const next = prev.filter((p) => aliveIds.has(p.id))
        return next.length === prev.length ? prev : next
      }
      setPromoProducts((prev) => {
        const kept = prev.filter((p) => aliveIds.has(p.id) && livePromoIds.has(p.id))
        return kept.length === prev.length ? prev : kept
      })
      setRegularProducts((prev) => {
        const demoted = promoProducts.filter(
          (p) => aliveIds.has(p.id) && !livePromoIds.has(p.id) && !prev.some((q) => q.id === p.id),
        )
        const kept = prev.filter((p) => aliveIds.has(p.id))
        const next = [...kept, ...demoted]
        return next.length === prev.length && demoted.length === 0 ? prev : next
      })
      setUpcomingProducts((prev) => prune(prev))
    }, 30_000)
    return () => clearInterval(id)
  }, [promoProducts, regularProducts, upcomingProducts])

  // 問候語：依時段變化
  const hour = new Date().getHours()
  const greeting =
    hour < 11 ? '早安' : hour < 14 ? '午安' : hour < 22 ? '晚安' : '夜深了'

  return (
    <div className="min-h-dvh bg-ink-50 pb-24">
      {/* 頂部：台灣電商風橘色漸層橫幅 */}
      <header className="bg-gradient-to-r from-accent-500 to-accent-600 px-3 md:px-5 py-3 md:py-4 sticky top-0 z-10 shadow-md">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between gap-2">
          {/* 標題區：可點回首頁 */}
          <Link to="/" className="min-w-0 hover:opacity-90 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-lg" aria-label="回到首頁">
            <div className="text-xs md:text-base tracking-widest text-accent-100 font-bold whitespace-nowrap">⚡ 先買先贏</div>
            <h1 className="text-base md:text-lg font-extrabold text-white tracking-wide whitespace-nowrap truncate">
              吸引力生活好物
            </h1>
          </Link>
          {/* 按鈕區：shrink-0 + nowrap，手機上永遠一行排開 */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to={isAdmin ? '/admin/orders' : '/orders'}
              className="whitespace-nowrap text-sm md:text-base font-bold px-3 md:px-4 py-2 rounded-full border border-white/60 text-white hover:bg-white/15 transition"
            >
              {isAdmin ? '訂單管理' : '訂單'}
            </Link>
            <Link
              to="/me/follows"
              aria-label="我的關注"
              className="whitespace-nowrap text-sm font-bold px-3 py-2 rounded-full bg-white/20 text-white hover:bg-white/30 transition"
            >
              🔔 關注
            </Link>
            <Link
              to="/cart"
              aria-label="購物車"
              className="relative w-9 h-9 md:w-10 md:h-10 rounded-full bg-white flex items-center justify-center text-base md:text-lg shadow-sm hover:bg-accent-50 transition"
            >
              🛒
              <CartBadge />
            </Link>
            <Link
              to="/profile"
              aria-label="我的帳號"
              className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-white flex items-center justify-center text-sm md:text-base font-bold text-accent-600 shadow-sm"
            >
              {customer?.name?.slice(0, 1) ?? '?'}
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-5 space-y-5">
        {/* 問候區（活潑電商風） */}
        <section className="pt-1 pb-1 anim-fade-up">
          <h2 className="text-[21px] md:text-3xl leading-snug font-extrabold text-ink-900 truncate">
            {greeting}，{customer?.name} 👋
          </h2>
          <p className="mt-1 text-base text-ink-500">
            好物正在降價中，手刀搶起來！🔥
          </p>
        </section>

        {/* 首頁廣告看板輪播 */}
        <BannerCarousel />

        {/* 下單規則說明 — 摺疊式（省 70% 高度，點開看 6 點） */}
        <section className="bg-white rounded-[16px] border border-ink-200 shadow-sm anim-fade-up overflow-hidden">
          <button type="button" onClick={() => setNoticeOpen(v => !v)} aria-expanded={noticeOpen} className="w-full flex items-center gap-2.5 px-4 py-3 text-left cursor-pointer hover:bg-ink-50/60 transition">
            <span className="shrink-0 w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center text-[13px]" aria-hidden="true">⚠️</span>
            <span className="flex-1 text-[14px] font-extrabold tracking-tight text-ink-900">購買注意事項｜下單前請留意</span>
            <span className={`shrink-0 text-ink-400 text-xs transition-transform ${noticeOpen ? 'rotate-90' : ''}`} aria-hidden="true">▸</span>
          </button>
          {noticeOpen && (
            <div className="px-4 pb-4">
              <div className="space-y-2 text-[14px] leading-[1.6] text-ink-700 pt-1">
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">1</span><p>越晚越便宜，售完即下架，被人買走就沒有了。</p></div>
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">2</span><p>放入購物車保留 60 秒，逾時即棄單，自動釋放庫存，讓給別人買。</p></div>
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">3</span><p>結帳即確認，<b className="text-red-600 bg-red-50 px-1 py-0.5 rounded">無法自行取消</b>，請謹慎下單。</p></div>
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">4</span><p>限量 1 件棄單後，系統冷卻 3 分鐘內不能再搶同一件商品。</p></div>
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">5</span><p>結帳後請找窗口付款，付款後為您備貨。</p></div>
                <div className="flex gap-2.5"><span className="shrink-0 w-5 h-5 rounded-full bg-ink-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">6</span><p>備貨後通知領貨，取貨完成，訂單才算完成。</p></div>
              </div>
              <p className="mt-3 pt-3 border-t border-ink-100 text-center text-[13px] font-bold text-accent-600">❤️ 心動別猶豫，結帳前再確認一次！</p>
            </div>
          )}
        </section>

        {loading && (
          <div className="space-y-5">
            <CardSkeleton />
          </div>
        )}
        {!loading && promoProducts.length === 0 && regularProducts.length === 0 && upcomingProducts.length === 0 && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🛍️</div>
            <p className="text-base text-ink-400">目前沒有進行中的團購商品</p>
          </div>
        )}
        {!loading && (promoProducts.length + regularProducts.length + upcomingProducts.length) > 0 && (
          <>
            {/* 限時促銷專區（置頂，突顯促銷商品） */}
            {promoProducts.length > 0 && (
              <section className="space-y-4">
                <div className="pt-1 flex flex-wrap items-center gap-2 anim-fade-up">
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="w-1 h-5 rounded-full bg-accent-500" aria-hidden="true" />
                    <h3 className="text-xl font-extrabold text-ink-900 whitespace-nowrap">限時促銷</h3>
                    {promoProducts[0] && (() => {
                      const first = promoInfo[promoProducts[0].id]?.[0]
                      const k = (first as { kind?: string } | undefined)?.kind ?? 'flash'
                      const L: Record<string, string> = { flash: '⚡ 限時場', accel: '🚀 加速場', bundle: '📦 組合場', clearance: '🏷️ 清倉場', focus: '⭐ 焦點新品' }
                      return <span className="text-sm font-bold text-accent-600 bg-accent-50 px-2.5 py-1 rounded-full whitespace-nowrap">{L[k] ?? '⚡ 限時場'}</span>
                    })()}
                  </div>
                  <span className="ml-auto text-sm font-bold text-accent-700 whitespace-nowrap">限量優惠，先搶先贏 →</span>
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
                  <h3 className="text-xl font-extrabold text-ink-900">{promoProducts.length > 0 ? '其他好物' : '限時好物'}</h3>
                  <span className="ml-auto text-sm font-bold text-accent-700 whitespace-nowrap">價格越晚越便宜？先搶先贏 →</span>
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
                  <h3 className="text-xl font-extrabold text-ink-900">即將開賣</h3>
                  <span className="ml-auto text-sm font-bold text-ink-500 whitespace-nowrap">Coming Soon</span>
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
