import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useFollow } from '../lib/useFollow'
import { useSharedClock } from '../lib/sharedClock'
import { registerPushSubscription } from '../lib/pushClient'
// 假信箱判斷：@phone/@name/@admin.groupbuy.local 皆為系統佔位
import type { Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatCountdown } from '../lib/pricing'

function FollowCard({ product, onUnfollow }: { product: Product; onUnfollow: (id: string) => void }) {
  const clock = useSharedClock()
  const nowMs = clock.nowMs + clock.offsetMs
  const saleStartMs = product.sale_start_at ? new Date(product.sale_start_at).getTime() : 0
  const isUpcoming = saleStartMs > nowMs
  const tick = isUpcoming ? Math.max(0, (saleStartMs - nowMs) / 1000) : 0
  const { notifySale, notify30, notify50, notify70, setThresholds } = useFollow(product.id)
  const allChecked = notify30 && notify50 && notify70
  const toggleAll = async (checked: boolean) => {
    await setThresholds({ t30: checked, t50: checked, t70: checked })
  }
  return (
    <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
      <Link to={`/product/${product.id}`} className="flex gap-3 p-3">
        <div className="w-20 h-20 rounded-xl bg-ink-100 overflow-hidden shrink-0 flex items-center justify-center">
          {product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <span className="text-2xl opacity-20">🎁</span>}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-ink-900 line-clamp-2 leading-snug">{product.name}</h3>
          <p className="mt-1 text-sm font-bold text-accent-600">{fmtMoney(Number(product.original_price))} 起</p>
          {isUpcoming ? <p className="mt-1 text-xs font-bold text-ink-600">⏳ {formatCountdown(tick)} 後開賣</p> : <p className="mt-1 text-xs text-green-600 font-bold">🔓 已開賣</p>}
        </div>
      </Link>
      <div className="px-3 pb-3 space-y-2">
        <div className="flex items-center justify-between bg-ink-50 rounded-xl px-3 py-2">
          <span className="text-xs font-bold text-ink-800">商品已關注</span>
          <button onClick={() => onUnfollow(product.id)} aria-label="取消關注" className="text-xs text-ink-500 hover:text-red-600 font-medium">✕ 取消關注</button>
        </div>
        <div className="bg-ink-50 rounded-xl px-3 py-2.5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 bg-white border border-ink-200 rounded-xl px-2.5 py-2 cursor-pointer active:bg-ink-50">
              <input type="checkbox" checked={notifySale} onChange={e => setThresholds({ sale: e.target.checked })} className="w-4 h-4 rounded border-ink-300 accent-ink-900" />
              <span className="text-xs font-bold text-ink-700">上架通知</span>
            </label>
            <label className="flex items-center gap-2 bg-white border border-ink-200 rounded-xl px-2.5 py-2 cursor-pointer active:bg-ink-50">
              <input type="checkbox" checked={notify30} onChange={e => setThresholds({ t30: e.target.checked })} className="w-4 h-4 rounded border-ink-300 accent-ink-900" />
              <span className="text-xs font-bold text-ink-700">降30%</span>
            </label>
            <label className="flex items-center gap-2 bg-white border border-ink-200 rounded-xl px-2.5 py-2 cursor-pointer active:bg-ink-50">
              <input type="checkbox" checked={notify50} onChange={e => setThresholds({ t50: e.target.checked })} className="w-4 h-4 rounded border-ink-300 accent-ink-900" />
              <span className="text-xs font-bold text-ink-700">降50%</span>
            </label>
            <label className="flex items-center gap-2 bg-white border border-ink-200 rounded-xl px-2.5 py-2 cursor-pointer active:bg-ink-50">
              <input type="checkbox" checked={notify70} onChange={e => setThresholds({ t70: e.target.checked })} className="w-4 h-4 rounded border-ink-300 accent-ink-900" />
              <span className="text-xs font-bold text-ink-700">降70%</span>
            </label>
          </div>
          <label className="flex items-center gap-2 bg-white border-2 border-accent-200 rounded-xl px-3 py-2 cursor-pointer active:bg-accent-50">
            <input type="checkbox" checked={allChecked} onChange={e => toggleAll(e.target.checked)} className="w-4 h-4 rounded border-ink-300 accent-accent-600" />
            <span className="text-xs font-bold text-accent-700">□ 全部通知（上架+30/50/70）</span>
          </label>
          <p className="text-[11px] text-ink-500 text-center">勾選即可同時關注多種通知</p>
        </div>
      </div>
    </div>
  )
}

export default function MyFollowsPage() {
  const { userId } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  // E-MAIL 通知信箱（與個人資料共用 admin 直通）
  const [emailInput, setEmailInput] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string|null>(null)
  const [userEmail, setUserEmail] = useState<string|null>(null)
  const isFake = (e:string)=> e.includes('@phone.groupbuy.local')||e.includes('@name.groupbuy.local')||e.includes('@admin.groupbuy.local')
  const loadEmail = async()=>{
    try{
      const { data } = await supabase.auth.getUser()
      const em = data.user?.email ?? (await supabase.auth.getSession()).data.session?.user?.email ?? null
      setUserEmail(em && !isFake(em) ? em : null)
      if(em && !isFake(em)) setEmailInput(em)
      else if(em && isFake(em)) setEmailInput('')
    }catch{ /* ignore */ }
  }
  useEffect(()=>{
    // eslint-disable-next-line react/set-state-in-effect -- 外部信箱資料同步，需等伺服器回應後才能更新
    void loadEmail()
  },[userId])
  useEffect(()=>{ const { data: sub } = supabase.auth.onAuthStateChange(()=> loadEmail()); return ()=> sub.subscription.unsubscribe() },[])
  const saveEmail = async()=>{
    setEmailMsg(null); const em=emailInput.trim().toLowerCase()
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)){setEmailMsg('❌ 信箱格式不正確');return}
    if(isFake(em)){setEmailMsg('❌ 請填真實信箱');return}
    setEmailBusy(true)
    try{
      const { data: sess }=await supabase.auth.getSession(); const token=sess.session?.access_token
      const fnBase=import.meta.env.VITE_SUPABASE_URL as string; const anonKey=import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const res=await fetch(`${fnBase}/functions/v1/admin`,{method:'POST',headers:{Authorization:`Bearer ${token}`,apikey:anonKey,'Content-Type':'application/json'},body:JSON.stringify({action:'updateOwnEmail',email:em})})
      const j=await res.json().catch(()=>null)
      if(!j?.ok) throw new Error(j?.reason==='exists'?'此信箱已被使用':j?.reason==='invalid_email'?'信箱格式不正確':'儲存失敗')
      try{ await supabase.auth.refreshSession(); }catch{ /* ignore */ }
      await loadEmail()
      setEmailMsg('✅ 信箱已更新，之後上架/降價會寄到這裡'); setUserEmail(em); setEmailInput(em)
    }catch(e){setEmailMsg(`❌ ${e instanceof Error?e.message:'儲存失敗'}`)}finally{setEmailBusy(false)}
  }

  const [pushState, setPushState] = useState<'idle'|'granted'|'denied'|'unsupported'>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported' as const
    const p = Notification.permission
    if (p === 'granted') return 'granted' as const
    if (p === 'denied') return 'denied' as const
    return 'idle' as const
  })
  const enablePush = async () => {
    const sub = await registerPushSubscription()
    if (sub) { setPushState('granted'); setMsg('✅ 推播已開啟，關掉網頁也能收到通知'); setTimeout(()=>setMsg(null),3000) }
    else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') { setPushState('denied'); setMsg('❌ 通知被封鎖，請到瀏覽器設定開啟') }
    else setMsg('推播開啟失敗，請確認是 HTTPS 並已登入')
  }

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    const { data: follows, error } = await supabase.from('product_follows').select('product_id').eq('user_id', userId)
    if (error) { setMsg('載入失敗'); setLoading(false); return }
    const ids = (follows ?? []).map((r: { product_id: string }) => r.product_id)
    if (ids.length === 0) { setProducts([]); setLoading(false); return }
    const { data: prods } = await supabase.from('products').select('*').in('id', ids)
    setProducts((prods as Product[]) ?? [])
    setLoading(false)
  }, [userId])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 外部關注清單同步，需等伺服器回應後才能更新
    void load()
  }, [load])

  const unfollow = async (productId: string) => {
    if (!userId) return
    const { error } = await supabase.from('product_follows').delete().eq('user_id', userId).eq('product_id', productId)
    if (error) { setMsg('取消失敗'); return }
    setProducts((prev) => prev.filter((p) => p.id !== productId))
    setMsg('已取消關注')
    setTimeout(() => setMsg(null), 2000)
  }

  if (loading) return <div className="min-h-dvh bg-ink-50 flex items-center justify-center"><p className="text-sm text-ink-400">載入中…</p></div>

  return (
    <div className="min-h-dvh bg-ink-50">
      <header className="sticky top-0 z-10 bg-white border-b border-ink-100 px-4 py-3 flex items-center gap-3">
        <Link to="/" aria-label="回到首頁" className="text-accent-600 font-bold">← 回首頁</Link>
        <h1 className="text-base font-bold text-ink-900">我的關注</h1>
        <span className="text-xs text-ink-500">{products.length} 項</span>
      </header>
      {/* E-MAIL 通知信箱 — 搬來我的關注，方便一次設定 */}
      <div className="max-w-md md:max-w-3xl mx-auto px-4 pt-3">
        <div className="rounded-2xl border border-ink-100 bg-[#FFF8F0] p-4 space-y-3">
          <p className="text-sm font-bold text-ink-800">💌 E-MAIL 通知信箱 {userEmail && <span className="text-xs font-normal text-green-600">（已設定：{userEmail}）</span>}</p>
          <p className="text-xs text-ink-500">填寫真實信箱，才能同時收到上架/降價 E-MAIL 通知</p>
          <div className="flex gap-2">
            <input type="email" placeholder="you@example.com" value={emailInput} onChange={e=>setEmailInput(e.target.value)} className="flex-1 h-10 px-4 rounded-full border border-ink-200 bg-white text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400" />
            <button onClick={saveEmail} disabled={emailBusy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.trim())} className="h-10 px-5 rounded-full bg-[#FF8A65] text-white text-sm font-bold disabled:opacity-40 shrink-0">儲存</button>
          </div>
          {emailMsg && <p className="text-xs text-center">{emailMsg}</p>}
        </div>
      </div>

      {pushState !== 'granted' && pushState !== 'unsupported' && (
        <div className="max-w-md md:max-w-3xl mx-auto px-4 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
            <span className="text-sm">{pushState==='denied' ? '🔕 通知被封鎖' : '🔔 開啟推播'}</span>
            <span className="text-xs text-ink-500 flex-1">{pushState==='denied' ? '請到瀏覽器設定允許通知' : '關掉網頁也能收到上架/降價通知'}</span>
            <button onClick={enablePush} className="h-8 px-3 rounded-full bg-accent-500 text-white text-xs font-bold active:scale-[0.98]">{pushState==='denied' ? '重試' : '開啟'}</button>
          </div>
        </div>
      )}
      <main className="max-w-md md:max-w-3xl mx-auto px-4 py-4">
        {msg && <p className="mb-3 text-center text-sm bg-white border border-ink-100 rounded-xl py-2">{msg}</p>}
        {products.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-3">🔔</p>
            <p className="text-base text-ink-600">尚未關注任何商品</p>
            <p className="text-sm text-ink-400 mt-1">看到喜歡的即將上架商品，按「🔔 關注上架」即可</p>
            <Link to="/" className="inline-block mt-4 h-10 px-6 rounded-xl bg-accent-500 text-white text-sm font-bold leading-10">去逛逛</Link>
          </div>
        ) : (
          <div className="grid gap-3">{products.map((p) => <FollowCard key={p.id} product={p} onUnfollow={unfollow} />)}</div>
        )}
      </main>
    </div>
  )
}
