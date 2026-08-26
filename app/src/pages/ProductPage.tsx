import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign, Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatCountdown, formatInterval } from '../lib/pricing'
import { useLivePrice } from '../lib/useLivePrice'
import type { PromoTag } from '../components/ProductShowcaseCard'
import { useAuth } from '../context/AuthContext'

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
  offer_ended: '😅 太猶豫囉！此優惠已結束，錯過就沒有了。',
  not_open_yet: '⏳ 尚未開賣，敬請期待，時間一到即可下單。',
  reservation_expired: '⌛ 考慮時間超過了，商品已回到架上，再試一次吧！',
  reservation_inactive: '此預訂已失效，請重新放入購物車。',
  not_found_or_not_owner: '找不到這筆預訂。',
  invalid_quantity: '數量不正確。',
}

/** 購物車 3 分鐘倒數提示條（歸零自動收起，庫存由伺服器 cron 釋回） */
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
  }, [expiresAt])
  const urgent = left <= 60
  return (
    <div className={`mb-2 rounded-xl px-4 py-2.5 text-base font-bold flex items-center justify-between
      ${urgent ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-accent-50 text-accent-700 border border-accent-200'}`}>
      <span>🛒 商品已為您保留（價格已鎖定）</span>
      <span className="tabular-nums">⏱ {formatCountdown(left)}</span>
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
        // 該商品的進行中活動（行銷展示層：只影響顯示，不影響銷售邏輯）
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

  const live = useLivePrice(product)

  // ---------- 關注：載入人數＋我的狀態，並訂閱即時變化 ----------
  useEffect(() => {
    if (!productId) return
    let alive = true

    ;(async () => {
      const { data: cnt } = await supabase
        .rpc('product_follower_count', { p_product_id: productId })
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

    // Realtime：任何人關注／取消關注，數字即時跳動
    const channel = supabase
      .channel(`follows-${productId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'product_follows', filter: `product_id=eq.${productId}` },
        () => {
          supabase
            .rpc('product_follower_count', { p_product_id: productId })
            .then(({ data: c }) => {
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
    if (!userId) {
      navigate('/login', { replace: true })
      return
    }
    if (!productId || followBusy) return
    setFollowBusy(true)
    // 樂觀更新：先改畫面再同步後端
    const next = !following
    setFollowing(next)
    setFollowerCount((n) => Math.max(0, n + (next ? 1 : -1)))
    try {
      if (next) {
        const { error } = await supabase
          .from('product_follows')
          .insert({ user_id: userId, product_id: productId })
        if (error && error.code !== '23505') throw error // 重複關注視為成功
      } else {
        const { error } = await supabase
          .from('product_follows')
          .delete()
          .eq('user_id', userId)
          .eq('product_id', productId)
        if (error) throw error
      }
    } catch {
      // 失敗回滾
      setFollowing(!next)
      setFollowerCount((n) => Math.max(0, n + (next ? -1 : 1)))
    } finally {
      setFollowBusy(false)
    }
  }

  // 價格下降時閃一下動畫
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
  // 尚未開賣（開賣時間在未來）→ 鎖定不可下單，顯示等待倒數
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

  // ---------- 購物車預訂制：放入購物車＝鎖庫存鎖價 3 分鐘 ----------
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
      } else {
        setBuyState({
          kind: 'error',
          message: REASON_TEXT[res.reason ?? ''] ?? '目前無法放入購物車，請稍後再試。',
        })
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
        setBuyState({
          kind: 'success',
          orderNo: String(res.order_no),
          unitPrice: Number(res.unit_price),
          quantity: Number(res.quantity),
        })
      } else {
        setBuyState({
          kind: 'error',
          message: REASON_TEXT[res.reason ?? ''] ?? '結帳失敗，請重新嘗試。',
        })
      }
    } catch {
      setBuyState({ kind: 'error', message: '網路異常，請確認連線後再試。' })
    }
  }

  const releaseCart = async () => {
    if (buyState.kind !== 'cart') return
    const rid = buyState.reservationId
    setBuyState({ kind: 'idle' })
    await rpc('release_reservation', { p_reservation_id: rid }).catch(() => null)
  }

  if (loading) {
    return (
      <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
        <p className="text-base text-ink-400">載入中…</p>
      </div>
    )
  }

  if (!product || !campaign) {
    return (
      <div className="min-h-dvh bg-ink-50 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base text-ink-500">找不到此商品</p>
        <Link to="/" className="text-base font-medium text-accent-600">回到活動列表</Link>
      </div>
    )
  }

  // 已降價幅度（原價 − 現價）
  const original = Number(product.original_price)
  const minimum = Math.min(Number(product.minimum_price), original)
  const atFloor = live.price <= minimum
  const dropped = original - live.price
  const dropPct = original > 0 ? Math.max(0, Math.min(100, (dropped / original) * 100)) : 0

  // ---- 特價倒數規則：熱銷 / 即將完售 / 到底價 FOMO（底價不外顯）----
  const stockPct = Math.max(0, Math.min(100, (live.stock / Math.max(1, product.initial_stock)) * 100))
  const soldPct = 100 - stockPct // 已售比例
  const hotLabel = soldPct >= 50 && live.stock > 0
  const almostGone = stockPct <= 20 && live.stock > 0

  // 規則：單程到底、只降不漲；到底價後停留一輪、無下單即由 Server 自動下架（歸零計時）
  // 降價說明文字（隨機區間或固定）
  const decLo = Number(product.price_decrease)
  const decHi = product.price_decrease_max != null ? Number(product.price_decrease_max) : decLo
  const dropLabel =
    decLo === decHi ? fmtMoney(decLo) : `${fmtMoney(decLo)} ~ ${fmtMoney(decHi)}`
  const canBuy = saleOpen && live.stock >= quantity && buyState.kind !== 'buying'

  return (
    <div className="min-h-dvh bg-ink-50 pb-28">
      {/* 頂部：倒數計時器進駐（P27——顯眼大字） */}
      <header className="bg-gradient-to-r from-accent-500 to-accent-600 px-4 py-3 sticky top-0 z-10 shadow-md">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 -ml-1.5 rounded-full hover:bg-white/20 text-white flex items-center justify-center shrink-0"
            aria-label="返回"
          >
            ←
          </button>

          {/* 中央：先買先贏 + 大字倒數 */}
          <div className="min-w-0 flex-1 text-center">
            <div className="text-xs tracking-widest text-accent-100 font-bold whitespace-nowrap">⚡ 先買先贏</div>
            {!atFloor ? (
              <div
                className="text-2xl md:text-4xl font-extrabold text-white tabular-nums leading-tight tracking-wide drop-shadow-sm"
                role="timer"
                aria-label={`下次降價倒數 ${formatCountdown(live.nextDropIn)}`}
              >
                ⏰ {formatCountdown(live.nextDropIn)}
              </div>
            ) : (
              <div className="text-xl md:text-2xl font-extrabold text-white leading-tight whitespace-nowrap">
                ✅ 已是最優惠價
              </div>
            )}
            <div className="text-[11px] md:text-xs text-accent-100 font-medium whitespace-nowrap">
              {!atFloor && '下次降價倒數'}
            </div>
          </div>

          <div className="w-11 shrink-0" />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto">
        {/* 商品圖 */}
        <div className="aspect-square bg-white border-b border-ink-100 flex items-center justify-center overflow-hidden">
          {product.image_url ? (
            <img src={product.image_url} alt={product.name} className="w-full h-full object-cover" />
          ) : (
            <span className="text-5xl opacity-20">🎁</span>
          )}
        </div>

        <div className="px-5 pt-5 space-y-5">
          {/* 名稱與描述 */}
          <div>
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-2xl font-bold text-ink-900 font-display">{product.name}</h1>
              {activePromos.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {activePromos.slice(0, 3).map((promo) => (
                    <span key={promo.name}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-50 border border-accent-200 px-3 py-1 text-sm font-bold text-accent-700">
                      {promo.icon ? `${promo.icon} ` : '🏷️ '}{promo.name}
                    </span>
                  ))}
                  {activePromos.length > 3 && (
                    <span className="text-sm font-bold text-accent-600">+{activePromos.length - 3}</span>
                  )}
                </div>
              )}
              {/* 關注按鈕 */}
              <button
                onClick={toggleFollow}
                disabled={followBusy}
                aria-pressed={following}
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-full text-base font-bold
                            border transition active:scale-95 disabled:opacity-60 ${
                  following
                    ? 'bg-accent-50 border-accent-300 text-accent-700'
                    : 'bg-white border-ink-200 text-ink-700'
                }`}
              >
                <span className={following ? 'anim-pop-in' : ''}>{following ? '❤️' : '🤍'}</span>
                {following ? '已關注' : '關注'}
              </button>
            </div>
            {product.description && (
              <p className="mt-1.5 text-base text-ink-600 leading-relaxed">{product.description}</p>
            )}
            <p className="mt-1 text-base text-ink-500">SKU：{product.sku}</p>
            {/* 關注人數（社會證明） */}
            {followerCount > 0 && (
              <p className={`mt-2 text-base ${followerCount >= 5 ? 'text-red-600 font-bold' : 'text-ink-600'}`}>
                🔥 {followerCount} 人正在關注這項商品
              </p>
            )}
          </div>

          {/* 價格主角區 */}
          <section className="bg-white rounded-2xl border border-ink-100 p-5 shadow-sm" aria-live="polite">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-base text-ink-500 mb-0.5">原價</div>
                <div className="text-base text-ink-500 line-through">
                  {fmtMoney(Number(product.original_price))}
                </div>
              </div>
              <div className="text-right">
                <div className="text-base text-ink-500 mb-0.5">目前價格</div>
                <div
                  className={`text-4xl font-extrabold tracking-tight transition-colors duration-500 ${
                    priceFlash ? 'text-green-600' : 'text-ink-900'
                  }`}
                >
                  {fmtMoney(live.price)}
                </div>
              </div>
            </div>

            {/* 優惠說明：還有多少空間（但不保證有貨） */}
            {!atFloor && (
              <p className="mt-2 text-base text-ink-600">
                再等等還會更便宜，但庫存有限、不保證買得到。
              </p>
            )}

            {/* 已降價 badge + 熱銷/完售標籤 */}
            <div className="mt-3 flex flex-wrap gap-2">
              {dropped > 0 && (
                <div className="inline-flex items-center gap-1.5 rounded-full bg-red-50 border border-red-100
                                px-3.5 py-1.5 text-base font-bold text-red-600 anim-pop-in">
                  <span>📉</span>
                  <span>已降價 {fmtMoney(dropped)}（{Math.round(dropPct)}% off）</span>
                </div>
              )}
              {hotLabel && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 border border-orange-200
                                px-3.5 py-1.5 text-base font-bold text-orange-600 anim-pop-in">
                  🔥 熱銷中
                </span>
              )}
              {almostGone && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3.5 py-1.5
                                text-base font-bold text-white anim-pop-in">
                  ⚡ 即將完售
                </span>
              )}
            </div>

            {/* 降價規則 + 倒數 */}
            <div className="mt-4 flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3 gap-3">
              <span className="text-base text-ink-700">
                每 {formatInterval(product.price_interval_seconds)} 隨機降 {dropLabel}
              </span>
              {!atFloor && (
                <span className="text-base font-bold tabular-nums text-ink-700">
                  下一次降價 {formatCountdown(live.nextDropIn)}
                </span>
              )}
            </div>

            {/* 降價進度條：原價 ── 目前 ── 優惠價 */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-sm text-ink-600 mb-1">
                <span>原價 {fmtMoney(original)}</span>
                <span className="font-bold text-ink-900">{dropped > 0 ? `已降 ${fmtMoney(dropped)}` : '原價即售價'}</span>
              </div>
              <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                    atFloor ? 'bg-green-500' : 'bg-gradient-to-r from-accent-400 to-accent-600'
                  }`}
                  style={{ width: `${dropPct}%` }}
                />
              </div>
            </div>

          </section>

          {/* 庫存 */}
          <section aria-label="剩餘庫存">
            <div className="flex items-center justify-between text-base mb-2">
              <span className="text-ink-600">剩餘庫存</span>
              <span className={`font-bold tabular-nums ${live.stock <= 3 ? 'text-red-600' : 'text-ink-900'}`}>
                {live.stock} 件
              </span>
            </div>
            <div className="h-2 rounded-full bg-ink-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                  live.stock <= 3 ? 'bg-red-500' : 'bg-accent-500'
                }`}
                style={{ width: `${stockPct}%` }}
              />
            </div>
            {live.stock <= 3 && live.stock > 0 && (
              <p className="mt-2 text-base font-bold text-red-600">僅剩最後 {live.stock} 件，錯過就沒有了</p>
            )}
          </section>

          {/* 底部 CTA 前的單位說明 */}
          {Number(product.items_per_unit) > 1 && (
            <p className="text-base text-ink-600">
              📦 銷售單位：{product.unit}（1 {product.unit} = {product.items_per_unit} 件）
            </p>
          )}

          {/* 數量選擇 */}
          <section>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-semibold text-ink-700">
                購買數量（每人限購 {product.max_per_customer} {product.unit ?? '件'}）
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1}
                  className="w-11 h-11 rounded-full border-2 border-ink-200 text-ink-700 text-xl disabled:opacity-30"
                  aria-label="減少數量"
                >
                  −
                </button>
                <span className="w-10 text-center text-lg font-bold tabular-nums">{quantity}</span>
                <button
                  onClick={() =>
                    setQuantity((q) =>
                      Math.min(product.max_per_customer, live.stock, q + 1),
                    )
                  }
                  disabled={quantity >= Math.min(product.max_per_customer, live.stock)}
                  className="w-11 h-11 rounded-full border-2 border-ink-200 text-ink-700 text-xl disabled:opacity-30"
                  aria-label="增加數量"
                >
                  +
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* 底部 Sticky CTA */}
      <div className="fixed bottom-0 inset-x-0 z-20">
        <div className="max-w-md md:max-w-3xl mx-auto bg-white/95 backdrop-blur border-t border-ink-100 px-4 pt-3 pb-safe">
          {buyState.kind === 'cart' && (
            <>
              <CartCountdown expiresAt={buyState.expiresAt} onExpire={() => setBuyState({ kind: 'idle' })} />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <button
                  onClick={checkoutCart}
                  className="h-14 rounded-2xl bg-accent-500 text-white text-base font-bold shadow-lg shadow-accent-500/25 active:scale-[0.98] transition"
                >
                  ✔ 結帳｜{fmtMoney(buyState.lockedPrice)} × {buyState.quantity}
                </button>
                <button
                  onClick={releaseCart}
                  className="h-14 px-4 rounded-2xl border border-ink-200 text-ink-600 text-base font-semibold active:scale-[0.98] transition"
                >
                  放棄
                </button>
              </div>
            </>
          )}
          {buyState.kind !== 'cart' && (
          <button
            onClick={addToCart}
            disabled={!canBuy}
            className={`w-full h-14 py-3.5 rounded-2xl text-base font-bold transition
              ${saleOpen && live.stock > 0
                ? 'bg-accent-500 text-white active:scale-[0.98] shadow-lg shadow-accent-500/25'
                : 'bg-ink-200 text-ink-400 cursor-not-allowed'}`}
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
                        ? `🛒 放入購物車｜${fmtMoney(live.price)} × ${quantity}`
                        : `🛒 放入購物車｜鎖定價 ${fmtMoney(live.price)} × ${quantity}`}
          </button>
          )}
          {saleOpen && live.stock > 0 && !atFloor && buyState.kind !== 'cart' && (
            <p className="mt-1.5 text-center text-base text-ink-600">
              再等等還會降，但庫存有限、不保證有貨
            </p>
          )}
        </div>
      </div>

      {/* 成功 / 失敗 Modal */}
      {(buyState.kind === 'success' || buyState.kind === 'soldout' || buyState.kind === 'error') && (
        <div className="fixed inset-0 z-30 flex items-center justify-center px-6 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-xs bg-white rounded-3xl p-7 text-center shadow-xl anim-pop-in">
            {buyState.kind === 'success' && (
              <>
                <div className="text-4xl mb-3">🎉</div>
                <h2 className="text-lg font-bold text-ink-900 font-display">搶購成功！</h2>
                <div className="mt-4 space-y-1.5 text-base">
                  <p className="text-ink-600">{product.name}</p>
                  <p className="text-ink-900">
                    成交價格 <span className="font-bold">{fmtMoney(buyState.unitPrice)}</span>
                    × {buyState.quantity}
                  </p>
                  <p className="text-base text-ink-500">訂單編號：{buyState.orderNo}</p>
                </div>
                <p className="mt-3 text-base font-semibold text-green-700 bg-green-50 rounded-lg py-2">
                  商品已為您保留。
                </p>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => { setBuyState({ kind: 'idle' }); navigate('/orders') }}
                    className="h-12 rounded-xl bg-ink-900 text-white text-base font-semibold"
                  >
                    查看訂單
                  </button>
                  <button
                    onClick={() => setBuyState({ kind: 'idle' })}
                    className="h-12 rounded-xl border border-ink-200 text-base font-medium text-ink-700"
                  >
                    繼續逛逛
                  </button>
                </div>
              </>
            )}
            {buyState.kind === 'soldout' && (
              <>
                <div className="text-4xl mb-3">😢</div>
                <h2 className="text-lg font-bold text-ink-900">慢了一步</h2>
                <p className="mt-2 text-base text-ink-500">商品已被其他客戶搶購完畢。</p>
                <button
                  onClick={() => setBuyState({ kind: 'idle' })}
                  className="mt-6 w-full h-12 rounded-xl bg-ink-900 text-white text-base font-semibold"
                >
                  我知道了
                </button>
              </>
            )}
            {buyState.kind === 'error' && (
              <>
                <div className="text-4xl mb-3">⚠️</div>
                <h2 className="text-base font-bold text-ink-900">無法完成購買</h2>
                <p className="mt-2 text-base text-ink-500">{buyState.message}</p>
                <button
                  onClick={() => setBuyState({ kind: 'idle' })}
                  className="mt-6 w-full h-12 rounded-xl bg-ink-900 text-white text-base font-semibold"
                >
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
