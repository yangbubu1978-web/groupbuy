import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useFollow } from '../lib/useFollow'
import type { Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatCountdown } from '../lib/pricing'

function FollowCard({ product, onUnfollow }: { product: Product; onUnfollow: (id: string) => void }) {
  const isUpcoming = !!product.sale_start_at && new Date(product.sale_start_at).getTime() > Date.now()
  const remain = isUpcoming ? Math.max(0, (new Date(product.sale_start_at!).getTime() - Date.now()) / 1000) : 0
  const [tick, setTick] = useState(remain)
  const { notifyPriceDrop, setNotifyPriceDrop } = useFollow(product.id)
  const [priceMode, setPriceMode] = useState<'off'|'once'|'all'>(notifyPriceDrop ? 'all' : 'off')
  useEffect(() => { setPriceMode(notifyPriceDrop ? 'all' : 'off') }, [notifyPriceDrop])
  const handleModeChange = async (v: 'off'|'once'|'all') => {
    setPriceMode(v)
    if (v === 'off') await setNotifyPriceDrop(false)
    else {
      await setNotifyPriceDrop(true)
      // once vs all 暫同為 true，後續可細分欄位 price_drop_mode
      if (v === 'once') { await supabase.from('product_follows').update({ price_drop_mode: 'once' }).eq('product_id', product.id) }
      else { await supabase.from('product_follows').update({ price_drop_mode: 'all' }).eq('product_id', product.id) }
    }
  }
  useEffect(() => {
    if (!isUpcoming) return
    const id = setInterval(() => setTick(Math.max(0, (new Date(product.sale_start_at!).getTime() - Date.now()) / 1000)), 1000)
    return () => clearInterval(id)
  }, [isUpcoming, product.sale_start_at])
  return (
    <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
      <Link to={`/product/${product.id}`} className="flex gap-3 p-3">
        <div className="w-20 h-20 rounded-xl bg-ink-100 overflow-hidden shrink-0 flex items-center justify-center">
          {product.image_url ? <img src={product.image_url} alt={product.name} className="w-full h-full object-cover" /> : <span className="text-2xl opacity-20">🎁</span>}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-ink-900 line-clamp-2 leading-snug">{product.name}</h3>
          <p className="mt-1 text-sm font-bold text-accent-600">{fmtMoney(Number(product.original_price))} 起</p>
          {isUpcoming ? <p className="mt-1 text-xs font-bold text-ink-600">⏳ {formatCountdown(tick)} 後開賣</p> : <p className="mt-1 text-xs text-green-600 font-bold">🔓 已開賣</p>}
        </div>
      </Link>
      <div className="px-3 pb-3 space-y-2">
        <label className="flex items-center justify-between bg-ink-50 rounded-xl px-3 py-2">
          <span className="text-xs font-bold text-ink-700">降價通知</span>
          <select value={priceMode} onChange={e => handleModeChange(e.target.value as 'off'|'once'|'all')} className="text-xs font-bold bg-white border border-ink-200 rounded-lg px-2 py-1">
            <option value="off">僅上架</option>
            <option value="once">上架 + 降30%</option>
            <option value="all">30% / 50% / 70% 全通知</option>
          </select>
        </label>
        <button onClick={() => onUnfollow(product.id)} aria-label="取消商品上架通知" className="w-full h-10 rounded-xl bg-ink-800 text-white text-sm font-bold active:scale-[0.98] transition">🔕 取消關注</button>
      </div>
    </div>
  )
}

export default function MyFollowsPage() {
  const { userId } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

  const load = async () => {
    if (!userId) return
    setLoading(true)
    const { data: follows, error } = await supabase.from('product_follows').select('product_id').eq('user_id', userId)
    if (error) { setMsg('載入失敗'); setLoading(false); return }
    const ids = (follows ?? []).map((r: { product_id: string }) => r.product_id)
    if (ids.length === 0) { setProducts([]); setLoading(false); return }
    const { data: prods } = await supabase.from('products').select('*').in('id', ids)
    setProducts((prods as Product[]) ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [userId])

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
