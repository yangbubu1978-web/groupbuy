import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign, Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatCountdown, formatInterval } from '../lib/pricing'
import { useLivePrice } from '../lib/useLivePrice'
import type { PromoTag } from '../components/ProductShowcaseCard'
import { useAuth } from '../context/AuthContext'
import FollowButton from '../components/FollowButton'

type BuyState =
  | { kind: 'idle' }
  | { kind: 'buying' }
  | { kind: 'success'; orderNo: string; unitPrice: number; quantity: number }
  | { kind: 'soldout' }
  | { kind: 'error'; message: string }
  | { kind: 'cart'; reservationId: string; lockedPrice: number; quantity: number; expiresAt: number }

const REASON_TEXT: Record<string, string> = {
  sold_out: '商品已被其他客戶搶購完畢。',
  limit_reached: '已達每人限購數量上限。',
  campaign_not_active: '活動已結束或尚未開始。',
  product_paused: '此商品目前暫停販售。',
  not_authorized: '您沒有參加此團購的權限。',
  account_inactive: '帳號已停用，請聯絡管理員。',
  account_blocked: '帳號已被封鎖，請聯絡管理員。',
  cooldown: '您剛棄單，此商品需冷卻 3 分鐘後才能再搶。',
  offer_ended: '😅 太猶豫囉！此優惠已結束，錯過就沒有了。',
  not_open_yet: '⏳ 尚未開賣，敬請期待，時間一到即可下單。',
  reservation_expired: '⌛ 考慮時間超過了，商品已回到架上，再試一次吧！',
  reservation_inactive: '此預訂已失效，請重新放入購物車。',
  not_found_or_not_owner: '找不到這筆預訂。',
  invalid_quantity: '數量不正確。',
}

/** 購物車倒數 — shadcn Card 風格膠囊條，BeUI 柔和警示 */
function CartCountdown({ expiresAt, onExpire }: { expiresAt: number; onExpire: () => void }) {
  const [left, setLeft] = useState(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)))
  useEffect(() => {
    const id = setInterval(() => {
      const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setLeft(s)
      if (s <= 0) {
        clearInterval(id)
        onExpire()
      }
    }, 250)
    return () => clearInterval(id)
  }, [expiresAt, onExpire])
  const urgent = left <= 60
  return (
    <div
      className={`mb-3 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 border shadow-sm backdrop-blur
        ${urgent
          ? 'bg-red-50/90 border-red-200 text-red-700 shadow-red-100/50'
          : 'bg-amber-50/90 border-amber-200 text-amber-800 shadow-amber-100/50'}`}
    >
      <span className="flex items-center gap-2 text-[15px] font-bold leading-none">
        <span className={`w-2 h-2 rounded-full shrink-0 ${urgent ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}`} />
        商品已為您保留（價格已鎖定）
      </span>
      <span className={`tabular-nums text-[15px] font-extrabold px-3 py-1.5 rounded-full border ${urgent ? 'bg-white border-red-200 text-red-700' : 'bg-white border-amber-200 text-amber-800'}`}>
        ⏱ {formatCountdown(left)}
      </span>
    </div>
  )
}

function ProductGallery({ product }: { product: Product }) {
  const gallery = [product.image_url, (product as unknown as { image_url_2?: string }).image_url_2, (product as unknown as { image_url_3?: string }).image_url_3].filter(Boolean) as string[]
  const [idx, setIdx] = useState(0)
  const touchX = useRef<number | null>(null)
  const go = (n: number) => setIdx(((n % gallery.length) + gallery.length) % gallery.length)
  useEffect(() => {
    if (gallery.length <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % gallery.length), 3000)
    return () => clearInterval(t)
  }, [gallery.length])
  useEffect(() => { if (idx >= gallery.length) setIdx(0) }, [gallery.length, idx])
  if (gallery.length === 0) return <div className="mx-3 mt-3 md:mx-0 md:mt-4 bg-white rounded-[24px] border border-ink-100 shadow-sm overflow-hidden"><div className="aspect-square grid place-items-center bg-gradient-to-b from-ink-50/50 to-white"><span className="text-6xl opacity-15">🎁</span></div></div>
  return (
    <div className="mx-3 mt-3 md:mx-0 md:mt-4 bg-white rounded-[24px] border border-ink-100 shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden relative select-none" onTouchStart={(e) => { touchX.current = e.touches[0].clientX }} onTouchEnd={(e) => { if (touchX.current == null) return; const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null; if (Math.abs(dx) > 40) go(idx + (dx < 0 ? 1 : -1)) }}>
      <div className="aspect-square flex items-center justify-center overflow-hidden bg-gradient-to-b from-ink-50/50 to-white"><img src={gallery[idx]} alt={`${product.name} ${idx + 1}/${gallery.length}`} className="w-full h-full object-cover transition-opacity duration-300" draggable={false} /></div>
      {gallery.length > 1 && <><button aria-label="上一張" onClick={() => go(idx - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/45 text-white grid place-items-center backdrop-blur-sm active:scale-95">‹</button><button aria-label="下一張" onClick={() => go(idx + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/45 text-white grid place-items-center backdrop-blur-sm active:scale-95">›</button><div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5 bg-black/35 backdrop-blur-sm rounded-full px-2.5 py-1.5">{gallery.map((_, i) => <button key={i} aria-label={`第${i + 1}張`} onClick={() => setIdx(i)} className={`w-2 h-2 rounded-full transition-all ${i === idx ? 'bg-white w-5' : 'bg-white/60'}`} />)}</div><span className="absolute top-2 right-2 bg-black/45 text-white text-[11px] font-bold px-2 py-1 rounded-full backdrop-blur-sm">{idx + 1}/{gallery.length}</span></>}
    </div>
  )
}

export default function ProductPage() {
  const { productId } = useParams<{ productId: string }>()
  const navigate = useNavigate()
  const { userId } = useAuth()
  const [product, setProduct] = useState<Product | null>(null)
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)
  const [quantity, setQuantity] = useState(1)
  const [buyState, setBuyState] = useState<BuyState>({ kind: 'idle' })
  const [priceFlash, setPriceFlash] = useState(false)
  const [activePromos, setActivePromos] = useState<PromoTag[]>([])

  // ---------- 關注（Follow）狀態 ----------
  const [following, setFollowing] = useState(false)
  const [followerCount, setFollowerCount] = useState(0)
  const [followBusy, setFollowBusy] = useState(false)

  // 載入商品與活動
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: p } = await supabase
        .from('products')
        .select('*')
        .eq('id', productId ?? '')
        .maybeSingle()
      if (!alive) return
      if (p) {
        setProduct(p as Product)
        const { data: c } = await supabase
          .from('campaigns')
          .select('*')
          .eq('id', (p as Product).campaign_id)
          .maybeSingle()
        if (alive && c) setCampaign(c as Campaign)
        const nowIso = new Date().toISOString()
        const { data: items } = await supabase
          .from('promotion_items')
          .select('promotions!inner(id, name, icon, kind, starts_at, ends_at, is_active, status, sort_order)')
          .eq('product_id', (p as Product).id)
          .gte('promotions.ends_at', nowIso)
          .lte('promotions.starts_at', nowIso)
          .eq('promotions.is_active', true)
          .eq('promotions.status', 'active')
          .order('promotions.sort_order', { ascending: true })
        if (alive) {
          setActivePromos(
            ((items ?? []) as unknown as { promotions: PromoTag | null }[])
              .map((x) => x.promotions)
              .filter((x): x is PromoTag => !!x),
          )
        }
      }
      if (alive) setLoading(false)
    })()
    return () => { alive = false }
  }, [productId])

  // 載入既有預約
  useEffect(() => {
    if (!productId || !userId) return
    let alive = true
    ;(async () => {
      const { data } = await supabase.from('cart_reservations')
        .select('id, quantity, locked_unit_price, expires_at')
        .eq('user_id', userId).eq('product_id', productId).eq('status', 'active').maybeSingle()
      if (!alive || !data) return
      const exp = new Date(String((data as unknown as { expires_at: string }).expires_at)).getTime()
      if (exp <= Date.now()) {
        try { await supabase.rpc('release_reservation', { p_reservation_id: (data as unknown as { id: string }).id }) } catch {}
        return
      }
      setBuyState({
        kind: 'cart',
        reservationId: String((data as unknown as { id: string }).id),
        lockedPrice: Number((data as unknown as { locked_unit_price: number }).locked_unit_price),
        quantity: Number((data as unknown as { quantity: number }).quantity),
        expiresAt: exp,
      })
    })()
    return () => { alive = false }
  }, [productId, userId])

  const live = useLivePrice(product)

  // ---------- 關注：載入人數＋我的狀態，並訂閱即時變化 ----------
  useEffect(() => {
    if (!productId) return
    let alive = true
    ;(async () => {
      const { data: cnt } = await supabase.rpc('product_follower_count', { p_product_id: productId })
      if (alive && cnt !== null) setFollowerCount(Number(cnt))
      if (userId) {
        const { data: mine } = await supabase
          .from('product_follows')
          .select('product_id')
          .eq('user_id', userId)
          .eq('product_id', productId)
          .maybeSingle()
        if (alive) setFollowing(!!mine)
      }
    })()
    const channel = supabase
      .channel(`follows-${productId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'product_follows', filter: `product_id=eq.${productId}` },
        () => {
          supabase.rpc('product_follower_count', { p_product_id: productId }).then(({ data: c }) => {
            if (alive && c !== null) setFollowerCount(Number(c))
          })
        },
      )
      .subscribe()
    return () => {
      alive = false
      supabase.removeChannel(channel)
    }
  }, [productId, userId])

  const toggleFollow = async () => {
    if (!userId) { navigate('/login', { replace: true }); return }
    if (!productId || followBusy) return
    setFollowBusy(true)
    const next = !following
    setFollowing(next)
    setFollowerCount((n) => Math.max(0, n + (next ? 1 : -1)))
    try {
      if (next) {
        const { error } = await supabase.from('product_follows').insert({ user_id: userId, product_id: productId })
        if (error && error.code !== '23505') throw error
      } else {
        const { error } = await supabase.from('product_follows').delete().eq('user_id', userId).eq('product_id', productId)
        if (error) throw error
      }
    } catch {
      setFollowing(!next)
      setFollowerCount((n) => Math.max(0, n + (next ? -1 : 1)))
    } finally {
      setFollowBusy(false)
    }
  }

  // 價格下降閃爍
  const prevPrice = useRef(live.price)
  useEffect(() => {
    if (live.price < prevPrice.current) {
      setPriceFlash(true)
      const id = setTimeout(() => setPriceFlash(false), 900)
      prevPrice.current = live.price
      return () => clearTimeout(id)
    }
    prevPrice.current = live.price
  }, [live.price])

  const now = Date.now()
  const saleStartMs = product?.sale_start_at ? new Date(product.sale_start_at).getTime() : 0
  const notOpenYet = saleStartMs > now
  const saleRemain = notOpenYet ? Math.max(0, (saleStartMs - now) / 1000) : 0
  const saleOpen = useMemo(() => {
    if (!product || !campaign) return false
    return (
      campaign.status === 'active' &&
      product.status === 'active' &&
      !notOpenYet &&
      new Date(campaign.start_at).getTime() <= now &&
      now <= new Date(campaign.end_at).getTime()
    )
  }, [product, campaign, now, notOpenYet])

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { ok: false, reason: 'server_error' }
    return data as { ok: boolean; reason?: string; [k: string]: unknown }
  }

  const addToCart = async () => {
    if (buyState.kind === 'buying') return
    setBuyState({ kind: 'buying' })
    try {
      const res = await rpc('reserve_product', { p_product_id: product!.id, p_quantity: quantity })
      if (res.ok) {
        setBuyState({
          kind: 'cart',
          reservationId: String(res.reservation_id),
          lockedPrice: Number(res.locked_unit_price),
          quantity: Number(res.quantity ?? quantity),
          expiresAt: new Date(String(res.expires_at)).getTime(),
        })
      } else if (res.reason === 'sold_out') {
        setBuyState({ kind: 'soldout' })
      } else if (res.reason === 'already_reserved') {
        setBuyState({
          kind: 'cart',
          reservationId: String(res.reservation_id),
          lockedPrice: buyState.kind === 'cart' ? buyState.lockedPrice : Number(product!.original_price),
          quantity: Number(quantity),
          expiresAt: new Date(String(res.expires_at)).getTime(),
        })
      } else if (res.reason === 'cooldown') {
        const secs = Number((res as unknown as { retry_after?: number }).retry_after ?? 180)
        setBuyState({ kind: 'error', message: `您剛棄單，此商品需冷卻 ${Math.ceil(secs/60)} 分鐘後才能再搶。` })
      } else {
        setBuyState({ kind: 'error', message: REASON_TEXT[res.reason ?? ''] ?? '目前無法放入購物車，請稍後再試。' })
      }
    } catch {
      setBuyState({ kind: 'error', message: '網路異常，請確認連線後再試。' })
    }
  }

  const checkoutCart = async () => {
    if (buyState.kind !== 'cart') return
    try {
      const res = await rpc('checkout_reservation', { p_reservation_id: buyState.reservationId })
      if (res.ok) {
        setBuyState({ kind: 'success', orderNo: String(res.order_no), unitPrice: Number(res.unit_price), quantity: Number(res.quantity) })
      } else {
        setBuyState({ kind: 'error', message: REASON_TEXT[res.reason ?? ''] ?? '結帳失敗，請重新嘗試。' })
      }
    } catch {
      setBuyState({ kind: 'error', message: '網路異常，請確認連線後再試。' })
    }
  }

  const releaseCart = async () => {
    if (buyState.kind !== 'cart') return
    const rid = buyState.reservationId
    setBuyState({ kind: 'idle' })
    try {
      const r = await rpc('release_reservation', { p_reservation_id: rid }) as unknown as { penalty_secs?: number }
      if (r && typeof r.penalty_secs === 'number' && r.penalty_secs > 0) {
        const s = r.penalty_secs
        const label = s >= 60 ? `${Math.floor(s/60)}分${s%60 ? `${s%60}秒` : ''}` : `${s}秒`
        setBuyState({ kind: 'error', message: `已棄單，此商品下次降價延後 ${label}。單件商品棄單將進入 3 分鐘冷卻。` })
        setTimeout(() => setBuyState({ kind: 'idle' }), 4000)
      }
    } catch {}
  }

  if (loading) {
    return (
      <div className="min-h-dvh bg-[#fcfcfc] flex items-center justify-center">
        <p className="text-[17px] text-ink-400">載入中…</p>
      </div>
    )
  }
  if (!product || !campaign) {
    return (
      <div className="min-h-dvh bg-[#fcfcfc] flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[17px] text-ink-500">找不到此商品</p>
        <Link to="/" className="text-[17px] font-semibold text-accent-600 underline-offset-4 hover:underline">回到活動列表</Link>
      </div>
    )
  }

  const displayPrice = buyState.kind === 'cart' ? buyState.lockedPrice : live.price
  const original = Number(product.original_price)
  const minimum = Math.min(Number(product.minimum_price), original)
  const atFloor = displayPrice <= minimum
  const dropped = original - displayPrice
  const dropPct = original > 0 ? Math.max(0, Math.min(100, (dropped / original) * 100)) : 0
  const stockPct = Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))
  const soldPct = 100 - stockPct
  const hotLabel = soldPct >= 50 && live.stock > 0
  const almostGone = stockPct <= 20 && live.stock > 0
  const decLo = Number(product.price_decrease)
  const decHi = product.price_decrease_max != null ? Number(product.price_decrease_max) : decLo
  const dropLabel = decLo === decHi ? fmtMoney(decLo) : `${fmtMoney(decLo)} ~ ${fmtMoney(decHi)}`
  const canBuy = saleOpen && live.stock >= quantity && buyState.kind !== 'buying'
  const qtyMax = Math.min(product.max_per_customer, live.stock)

  return (
    <div className="min-h-dvh bg-[#fcfcfc] pb-32">
      {/* ─── 頂部倒數 — 玻璃漸層 header（shadcn 陰影 + BeUI 微動） ─── */}
      <header className="sticky top-0 z-10 bg-gradient-to-br from-accent-500 via-accent-500 to-accent-600 shadow-[0_4px_24px_rgba(238,77,45,0.25),0_1px_3px_rgba(0,0,0,0.08)]">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between gap-3 px-4 py-3.5">
          <button
            onClick={() => { if (window.history.length > 1) navigate(-1); else navigate('/', { replace: true }) }}
            className="w-10 h-10 -ml-1 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur text-white flex items-center justify-center shrink-0 transition active:scale-95 border border-white/20"
            aria-label="返回"
          >
            <span className="text-lg leading-none">‹</span>
          </button>

          <Link to="/" className="min-w-0 flex-1 text-center rounded-xl px-2 py-1 hover:bg-white/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60" aria-label="回到首頁">
            <div className="text-[11px] tracking-[0.18em] text-white/85 font-bold">⚡ 先買先贏 · 荷蘭式降價</div>
            {buyState.kind === 'cart' ? (
              <>
                <div className="text-[22px] md:text-[30px] font-extrabold text-white leading-tight tracking-tight">
                  🔒 價格已鎖定 {fmtMoney(buyState.lockedPrice)}
                </div>
                <div className="text-[11px] md:text-xs text-white/80 font-medium">結帳前不會再變動</div>
              </>
            ) : !atFloor ? (
              <>
                <div
                  className="text-[26px] md:text-[36px] font-extrabold text-white tabular-nums leading-tight tracking-wide drop-shadow-[0_1px_8px_rgba(0,0,0,0.15)]"
                  role="timer"
                  aria-label={`下次降價倒數 ${formatCountdown(live.nextDropIn)}`}
                >
                  ⏰ {formatCountdown(live.nextDropIn)}
                </div>
                <div className="text-[11px] md:text-xs text-white/80 font-medium tracking-wide">下次降價倒數</div>
              </>
            ) : (
              <div className="text-xl md:text-2xl font-extrabold text-white leading-tight">✅ 已是最優惠價</div>
            )}
          </Link>

          <div className="w-10 shrink-0" />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto">
        <ProductGallery product={product} />

        <div className="px-4 md:px-0 pt-6 space-y-6">
          {/* ─── 名稱與描述 — 加大行距、長輩友善 ─── */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-[22px] md:text-2xl font-bold text-ink-900 leading-snug tracking-tight flex-1 min-w-0">
                {product.name}
              </h1>
              {/* 關注按鈕 — shadcn pill + 微陰影 */}
              <button
                onClick={toggleFollow}
                disabled={followBusy}
                aria-pressed={following}
                className={`shrink-0 inline-flex items-center gap-1.5 px-4 h-11 rounded-full text-[15px] font-bold border shadow-sm transition-all active:scale-[0.96] disabled:opacity-60
                  ${following
                    ? 'bg-ink-900 border-ink-900 text-white shadow-ink-900/15 hover:bg-ink-800'
                    : 'bg-white border-ink-200 text-ink-700 hover:border-ink-300 hover:bg-ink-50'}`}
              >
                <span className={following ? 'anim-pop-in' : ''}>{following ? '❤️' : '🤍'}</span>
                {following ? '已關注' : '關注'}
              </button>
            </div>

            {/* Promo 標籤列 */}
            {activePromos.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {activePromos.slice(0, 3).map((promo) => (
                  <span key={promo.name} className="inline-flex items-center gap-1 rounded-full bg-accent-50 border border-accent-200/70 px-3.5 py-1.5 text-[13px] font-bold text-accent-700 shadow-sm">
                    {promo.icon ? `${promo.icon} ` : '🏷️ '}{promo.name}
                  </span>
                ))}
                {activePromos.length > 3 && (
                  <span className="text-sm font-bold text-accent-600">+{activePromos.length - 3}</span>
                )}
              </div>
            )}

            {product.description && (
              <p className="text-[15px] md:text-[16px] text-ink-600 leading-relaxed">{product.description}</p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[13px] text-ink-400 bg-ink-50 border border-ink-100 rounded-full px-3 py-1">SKU：{product.sku}</span>
              {followerCount > 0 && (
                <span className={`inline-flex items-center gap-1.5 text-[14px] px-3 py-1 rounded-full border shadow-sm ${followerCount >= 5 ? 'bg-red-50 border-red-200 text-red-700 font-bold' : 'bg-white border-ink-200 text-ink-600 font-medium'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${followerCount >= 5 ? 'bg-red-500 animate-pulse' : 'bg-ink-400'}`} />
                  {followerCount} 人正在關注
                </span>
              )}
            </div>
          </div>

          {/* ─── 價格主角卡 — shadcn Card 立體化 ─── */}
          <section
            className="bg-white rounded-[24px] border border-ink-100 shadow-[0_8px_32px_rgba(0,0,0,0.06),0_1px_4px_rgba(0,0,0,0.04)] p-5 md:p-6 space-y-4"
            aria-live="polite"
          >
            {/* 卡片頂部標籤 */}
            <div className="flex items-center gap-2">
              <span className="h-6 px-3 rounded-full bg-ink-900 text-white text-xs font-bold tracking-wide inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden="true" />限時降價中</span>
              {buyState.kind === 'cart' && (
                <span className="h-6 px-2.5 rounded-full bg-emerald-500 text-white text-xs font-bold inline-flex items-center gap-1">🔒 已鎖定</span>
              )}
            </div>

            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-[13px] font-semibold tracking-wide text-ink-400 mb-1">原價</div>
                <div className="text-[16px] text-ink-400 line-through decoration-ink-300">{fmtMoney(Number(product.original_price))}</div>
              </div>
              <div className="text-right">
                <div className="text-[13px] font-semibold tracking-wide text-ink-400 mb-1">
                  {buyState.kind === 'cart' ? '已鎖定價格' : '目前價格'}
                </div>
                <div className={`text-[36px] md:text-[40px] font-extrabold tracking-tight leading-none transition-colors duration-500 ${priceFlash ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fmtMoney(displayPrice)}
                </div>
              </div>
            </div>

            {!atFloor && (
              <p className="text-[14px] text-ink-500 leading-relaxed bg-ink-50 rounded-xl px-3.5 py-2.5 border border-ink-100">
                💡 再等等還會更便宜，但庫存有限、不保證買得到。
              </p>
            )}

            {/* 徽章列 */}
            <div className="flex flex-wrap gap-2">
              {dropped > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 border border-red-200 px-3.5 py-1.5 text-[14px] font-bold text-red-600 shadow-sm anim-pop-in">
                  📉 已降 {fmtMoney(dropped)}（{Math.round(dropPct)}% off）
                </span>
              )}
              {hotLabel && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 border border-orange-200 px-3.5 py-1.5 text-[14px] font-bold text-orange-600 shadow-sm anim-pop-in">
                  🔥 熱銷中
                </span>
              )}
              {almostGone && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-red-500 to-red-600 px-3.5 py-1.5 text-[14px] font-bold text-white shadow-md shadow-red-500/20 anim-pop-in">
                  ⚡ 即將完售
                </span>
              )}
            </div>

            {/* 降價規則條 — 柔和內嵌卡 */}
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-ink-50 border border-ink-100 px-4 py-3.5">
              <span className="text-[14px] font-medium text-ink-700">每 {formatInterval(product.price_interval_seconds)} 隨機降 {dropLabel}</span>
              {buyState.kind === 'cart' ? (
                <span className="text-[13px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">🔒 已鎖定</span>
              ) : (
                !atFloor && (
                  <span className="text-[13px] font-bold tabular-nums text-ink-700 bg-white border border-ink-200 rounded-full px-3 py-1 shadow-sm">
                    下次 {formatCountdown(live.nextDropIn)}
                  </span>
                )
              )}
            </div>

            {/* 降價進度條 */}
            <div>
              <div className="flex items-center justify-between text-[13px] mb-2">
                <span className="text-ink-500">原價 {fmtMoney(original)}</span>
                <span className="font-bold text-ink-900">{dropped > 0 ? `已降 ${fmtMoney(dropped)}` : '原價即售價'}</span>
              </div>
              <div className="h-2.5 rounded-full bg-ink-100 overflow-hidden p-0.5">
                <div
                  className={`h-full rounded-full transition-[width] duration-700 ease-out ${atFloor ? 'bg-emerald-500' : 'bg-gradient-to-r from-accent-400 to-accent-600'}`}
                  style={{ width: `${dropPct}%` }}
                />
              </div>
            </div>
          </section>

          {/* ─── 庫存卡 — 內嵌式 shadcn ─── */}
          <section aria-label="剩餘庫存" className="bg-white rounded-[20px] border border-ink-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[15px] font-semibold text-ink-700 flex items-center gap-2">
                <span className="w-7 h-7 rounded-full bg-ink-50 border border-ink-100 flex items-center justify-center text-sm">📦</span>
                剩餘庫存
              </span>
              <span className={`text-[15px] font-extrabold tabular-nums px-3 py-1 rounded-full border ${live.stock <= 3 ? 'bg-red-50 border-red-200 text-red-600' : 'bg-ink-50 border-ink-200 text-ink-900'}`}>
                {live.stock} 件
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-ink-100 overflow-hidden p-0.5">
              <div
                className={`h-full rounded-full transition-[width] duration-700 ease-out ${live.stock <= 3 ? 'bg-red-500' : 'bg-accent-500'}`}
                style={{ width: `${stockPct}%` }}
              />
            </div>
            {live.stock <= 3 && live.stock > 0 && (
              <p className="mt-3 text-[14px] font-bold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3.5 py-2">⚠️ 僅剩最後 {live.stock} 件，錯過就沒有了</p>
            )}
            {live.stock <= 0 && (
              <p className="mt-3 text-[14px] font-bold text-ink-500 bg-ink-50 border border-ink-200 rounded-xl px-3.5 py-2">已完售，敬請期待下一檔</p>
            )}
          </section>

          {Number(product.items_per_unit) > 1 && (
            <p className="text-[14px] text-ink-600 bg-white border border-ink-100 rounded-2xl px-4 py-3 shadow-sm">
              📦 銷售單位：{product.unit}（1 {product.unit} = {product.items_per_unit} 件）
            </p>
          )}

          {/* ─── 數量選擇 — 分段式 stepper（BeUI 膠囊） ─── */}
          <section className="bg-white rounded-[20px] border border-ink-100 shadow-sm p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[15px] font-bold text-ink-800">購買數量</div>
                <div className="text-[13px] text-ink-500 mt-0.5">每人限購 {product.max_per_customer} {product.unit ?? '件'}</div>
              </div>
              {/* Segmented stepper */}
              <div className="inline-flex items-center gap-1 bg-ink-50 border border-ink-200 rounded-full p-1.5 shadow-inner">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1}
                  className="w-10 h-10 rounded-full bg-white border border-ink-200 text-ink-700 text-lg font-bold shadow-sm flex items-center justify-center transition active:scale-90 disabled:opacity-30 disabled:shadow-none hover:border-ink-300 hover:shadow"
                  aria-label="減少數量"
                >
                  −
                </button>
                <span className="w-12 text-center text-[18px] font-extrabold tabular-nums text-ink-900 select-none">{quantity}</span>
                <button
                  onClick={() => setQuantity((q) => Math.min(qtyMax, q + 1))}
                  disabled={quantity >= qtyMax}
                  className="w-10 h-10 rounded-full bg-white border border-ink-200 text-ink-700 text-lg font-bold shadow-sm flex items-center justify-center transition active:scale-90 disabled:opacity-30 disabled:shadow-none hover:border-ink-300 hover:shadow"
                  aria-label="增加數量"
                >
                  +
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ─── 底部 Sticky CTA — 懸浮卡片（shadcn + 漸層按鈕） ─── */}
      <div className="fixed bottom-0 inset-x-0 z-20">
        <div className="max-w-md md:max-w-3xl mx-auto bg-white/95 backdrop-blur-xl border-t border-ink-100 shadow-[0_-8px_32px_rgba(0,0,0,0.08)] rounded-t-[20px] md:rounded-t-[24px] px-4 pt-4 pb-4 md:pb-5 pb-safe">
          {buyState.kind === 'cart' && (
            <>
              <CartCountdown
                expiresAt={buyState.expiresAt}
                onExpire={async () => {
                  const rid = buyState.kind === 'cart' ? buyState.reservationId : null
                  setBuyState({ kind: 'idle' })
                  if (rid) try { await supabase.rpc('release_reservation', { p_reservation_id: rid }) } catch {}
                }}
              />
              <div className="grid grid-cols-[1fr_auto] gap-2.5">
                <button
                  onClick={checkoutCart}
                  className="h-[56px] rounded-full bg-gradient-to-r from-accent-500 to-accent-600 hover:from-accent-600 hover:to-accent-600 text-white text-[16px] font-extrabold tracking-wide shadow-[0_6px_20px_rgba(238,77,45,0.35),0_1px_3px_rgba(0,0,0,0.08)] active:scale-[0.97] transition-all border border-accent-600/20"
                >
                  ✔ 結帳｜{fmtMoney(buyState.lockedPrice)} × {buyState.quantity}
                </button>
                <button
                  onClick={releaseCart}
                  className="h-[56px] px-6 rounded-full bg-white border border-ink-200 text-ink-600 text-[15px] font-bold shadow-sm hover:bg-ink-50 hover:border-ink-300 active:scale-[0.97] transition-all"
                >
                  放棄
                </button>
              </div>
            </>
          )}
          {notOpenYet && buyState.kind !== 'cart' && product && (
            <div className="mb-3">
              <FollowButton productId={product.id} saleStartAt={product.sale_start_at} size="detail" />
            </div>
          )}
          {buyState.kind !== 'cart' && (
            <button
              onClick={addToCart}
              disabled={!canBuy}
              className={`w-full h-[56px] rounded-full text-[16px] font-extrabold tracking-wide transition-all border active:scale-[0.97]
                ${saleOpen && live.stock > 0
                  ? 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-600 text-white shadow-[0_6px_20px_rgba(239,68,68,0.35),0_1px_3px_rgba(0,0,0,0.08)] border-red-600/20'
                  : 'bg-ink-100 text-ink-400 border-ink-200 cursor-not-allowed shadow-none'}`}
            >
              {buyState.kind === 'buying'
                ? '處理中…'
                : notOpenYet
                  ? `⏳ ${formatCountdown(saleRemain)} 後開賣`
                  : !saleOpen
                    ? '活動未開放'
                    : live.stock <= 0
                      ? '已完售'
                      : atFloor
                        ? `🛒 放入購物車｜${fmtMoney(displayPrice)} × ${quantity}`
                        : `🛒 放入購物車｜鎖定價 ${fmtMoney(displayPrice)} × ${quantity}`}
            </button>
          )}
          {saleOpen && live.stock > 0 && !atFloor && buyState.kind !== 'cart' && (
            <p className="mt-2.5 text-center text-[13px] text-ink-500">再等等還會降，但庫存有限、不保證有貨</p>
          )}
        </div>
      </div>

      {/* ─── 成功 / 失敗 Modal — shadcn Dialog 風格 ─── */}
      {(buyState.kind === 'success' || buyState.kind === 'soldout' || buyState.kind === 'error') && (
        <div className="fixed inset-0 z-30 flex items-center justify-center px-6 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-[28px] p-7 md:p-8 text-center shadow-[0_24px_64px_rgba(0,0,0,0.18),0_4px_16px_rgba(0,0,0,0.08)] border border-ink-100 anim-pop-in">
            {buyState.kind === 'success' && (
              <>
                <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center text-2xl">🎉</div>
                <h2 className="text-xl font-extrabold text-ink-900 tracking-tight">搶購成功！</h2>
                <div className="mt-4 space-y-1.5 text-[15px]">
                  <p className="text-ink-600">{product.name}</p>
                  <p className="text-ink-900">成交價格 <span className="font-extrabold">{fmtMoney(buyState.unitPrice)}</span> × {buyState.quantity}</p>
                  <p className="text-[13px] text-ink-400 font-mono">訂單編號：{buyState.orderNo}</p>
                </div>
                <p className="mt-4 text-[14px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-2xl py-2.5">商品已為您保留</p>
                <div className="mt-6 grid grid-cols-2 gap-2.5">
                  <button onClick={() => { setBuyState({ kind: 'idle' }); navigate('/orders') }} className="h-12 rounded-full bg-ink-900 hover:bg-ink-800 text-white text-[15px] font-bold shadow-md active:scale-[0.97] transition">
                    查看訂單
                  </button>
                  <button onClick={() => setBuyState({ kind: 'idle' })} className="h-12 rounded-full bg-white border border-ink-200 text-[15px] font-semibold text-ink-700 hover:bg-ink-50 active:scale-[0.97] transition">
                    繼續逛逛
                  </button>
                </div>
              </>
            )}
            {buyState.kind === 'soldout' && (
              <>
                <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-ink-50 border border-ink-100 flex items-center justify-center text-2xl">😢</div>
                <h2 className="text-lg font-extrabold text-ink-900">慢了一步</h2>
                <p className="mt-2 text-[15px] text-ink-500 leading-relaxed">商品已被其他客戶搶購完畢。</p>
                <button onClick={() => setBuyState({ kind: 'idle' })} className="mt-6 w-full h-12 rounded-full bg-ink-900 hover:bg-ink-800 text-white text-[15px] font-bold active:scale-[0.97] transition">
                  我知道了
                </button>
              </>
            )}
            {buyState.kind === 'error' && (
              <>
                <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-2xl">⚠️</div>
                <h2 className="text-[16px] font-extrabold text-ink-900">無法完成購買</h2>
                <p className="mt-2 text-[15px] text-ink-500 leading-relaxed">{buyState.message}</p>
                <button onClick={() => setBuyState({ kind: 'idle' })} className="mt-6 w-full h-12 rounded-full bg-ink-900 hover:bg-ink-800 text-white text-[15px] font-bold active:scale-[0.97] transition">
                  我知道了
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
