import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign, Company, CustomerGroup, Product, Promotion } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatInterval } from '../lib/pricing'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmDialog'

function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ───────── status meta ───────── */
const STATUS_META: Record<Product['status'], { label: string; dot: string; badge: string }> = { // paused 已整合至 ended，保留僅為相容舊資料
  active: { label: '銷售中', dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  draft: { label: '草稿', dot: 'bg-amber-400', badge: 'bg-amber-50 text-amber-700 ring-amber-200' },
  paused: { label: '已暫停', dot: 'bg-zinc-400', badge: 'bg-zinc-100 text-zinc-600 ring-zinc-200' },
  ended: { label: '已下架', dot: 'bg-orange-400', badge: 'bg-orange-50 text-orange-600 ring-orange-200' },
}

function StatusBadge({ status }: { status: Product['status'] }) {
  const m = STATUS_META[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${m.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  )
}

export default function AdminProductsPage() {
  const { isAdmin, loading: authLoading, userId } = useAuth()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileRef2 = useRef<HTMLInputElement>(null)
  const fileRef3 = useRef<HTMLInputElement>(null)
  const isAdminUser = useRef(false)
  const ask = useConfirm()

  const uploadImage = async (file: File): Promise<string> => {
    if (userId) {
      const { data: a } = await supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle()
      isAdminUser.current = !!a
      if (!a) throw new Error('僅管理員可上傳圖片')
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png'
    const path = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage.from('media').upload(path, file, {
      contentType: file.type, cacheControl: '3600', upsert: false,
    })
    if (error) throw new Error(`圖片上傳失敗：${error.message}`)
    const { data } = supabase.storage.from('media').getPublicUrl(path)
    return data.publicUrl
  }

  // 舊單圖上傳保留相容，三圖改用各 slot 內 onPick
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [duplicateMode, setDuplicateMode] = useState(false)
  const editId = duplicateMode ? null : searchParams.get('id')

  const [products, setProducts] = useState<Product[]>([])
  const [, setCampaigns] = useState<Campaign[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [groups, setGroups] = useState<CustomerGroup[]>([])
  const [showForm, setShowForm] = useState(!!editId)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [blockedProduct, setBlockedProduct] = useState<{ p: Product; orderCount: number } | null>(null)
  const [loaded, setLoaded] = useState(!editId)
  const [keyword, setKeyword] = useState('')

  const emptyForm = {
    campaign_id: '', name: '', description: '', image_url: '', image_url_2: '', image_url_3: '', sku: '',
    item_no: '',
    original_price: '1500', minimum_price: '900',
    price_interval_seconds: '7200', price_decrease: '1', price_decrease_max: '20',
    initial_stock: '20', max_per_customer: '2',
    unit: '件', items_per_unit: '1',
    sale_start_at: '',
    _origSaleStartNull: true,
    forced_delist_at: '',
    status: 'active' as Product['status'],
    scope: 'all' as 'all' | 'companies' | 'groups',
    company_ids: [] as string[], group_ids: [] as string[],
  }
  const [form, setForm] = useState(emptyForm)

  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [promoIds, setPromoIds] = useState<string[]>([])

  type StatusFilter = 'all' | Product['status']
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showSoldout, setShowSoldout] = useState(false)

  const visibleProducts = useMemo(() => {
    let list = statusFilter === 'all' ? products : products.filter((x) => x.status === statusFilter)
    if (!showSoldout) list = list.filter((x) => !(x.status === 'ended' && x.stock <= 0))
    const kw = keyword.trim().toLowerCase()
    if (kw) {
      list = list.filter((p) =>
        p.name.toLowerCase().includes(kw) ||
        p.sku.toLowerCase().includes(kw) ||
        ((p as unknown as { item_no?: string }).item_no ?? '').toLowerCase().includes(kw),
      )
    }
    return list
  }, [products, statusFilter, keyword, showSoldout])

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  useEffect(() => {
    ;(async () => {
      const [{ data: ps }, { data: cs }, { data: cos }, { data: gs }, { data: prs }] =
        await Promise.all([
          supabase.from('products').select('*').order('created_at', { ascending: false }),
          supabase.from('campaigns').select('*').order('created_at', { ascending: false }),
          supabase.from('companies').select('*'),
          supabase.from('customer_groups').select('*'),
          supabase.from('promotions').select('*').order('created_at', { ascending: false }),
        ])
      if (ps) setProducts(ps as Product[])
      if (cs) {
        setCampaigns(cs as Campaign[])
        setForm((f) => (f.campaign_id ? f : { ...f, campaign_id: (cs[0]?.id ?? '') }))
      }
      if (cos) setCompanies(cos as Company[])
      if (gs) setGroups(gs as CustomerGroup[])
      if (prs) setPromotions(prs as Promotion[])
    })()
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 表單顯示需跟網址編輯狀態同步，屬外部路由狀態
    if (!editId && !duplicateMode) setShowForm(false)
  }, [editId, duplicateMode])
  useEffect(() => {
    const onReset = (e: Event) => {
      if ((e as CustomEvent).detail !== '/admin/products') return
      if (duplicateMode) return
      setShowForm(false)
      navigate('/admin/products', { replace: true })
    }
    window.addEventListener('admin-nav-reset', onReset)
    return () => window.removeEventListener('admin-nav-reset', onReset)
  }, [duplicateMode, navigate])

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 外部商品資料同步，需等伺服器回應後才能更新
    if (!editId) { setLoaded(true); return }
    setShowForm(true)
    ;(async () => {
      const { data } = await supabase.from('products').select('*').eq('id', editId).maybeSingle()
      if (data) {
        const p = data as Product
        setForm({
          campaign_id: p.campaign_id,
          name: p.name,
          description: p.description ?? '',
          image_url: p.image_url ?? '',
          image_url_2: (p as unknown as { image_url_2?: string }).image_url_2 ?? '',
          image_url_3: (p as unknown as { image_url_3?: string }).image_url_3 ?? '',
          sku: p.sku,
          item_no: (p as unknown as { item_no?: string }).item_no ?? '',
          original_price: String(p.original_price),
          minimum_price: String(p.minimum_price),
          price_interval_seconds: String(p.price_interval_seconds),
          price_decrease: String(p.price_decrease),
          price_decrease_max: p.price_decrease_max != null ? String(p.price_decrease_max) : '',
          initial_stock: String(p.initial_stock),
          max_per_customer: String(p.max_per_customer),
          unit: p.unit ?? '件',
          items_per_unit: String(p.items_per_unit ?? 1),
          sale_start_at: p.sale_start_at ? toLocalInputValue(p.sale_start_at) : '',
          forced_delist_at: p.forced_delist_at ? toLocalInputValue(p.forced_delist_at) : '',
          status: p.status,
          _origSaleStartNull: !p.sale_start_at,
          scope: 'all',
          company_ids: [], group_ids: [],
        })
        const { data: items } = await supabase.from('promotion_items').select('promotion_id').eq('product_id', editId)
        if (items) setPromoIds(items.map((i) => i.promotion_id))
      }
      setLoaded(true)
    })()
  }, [editId])

  const reloadProducts = async () => {
    const { data } = await supabase.from('products').select('*').order('created_at', { ascending: false })
    if (data) setProducts(data as Product[])
  }

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      let targetCampaign = form.campaign_id
      if (!targetCampaign) {
        const { data: existing } = await supabase.from('campaigns').select('id').limit(1)
        if (existing && existing.length > 0) {
          targetCampaign = (existing[0] as { id: string }).id
        } else {
          const now = new Date()
          const start = new Date(now.getTime() - 3600_000)
          const end = new Date(now.getTime() + 365 * 86400_000)
          const { data: created, error: cErr } = await supabase.from('campaigns').insert({
            name: '預設活動', description: '系統自動建立', status: 'active',
            start_at: start.toISOString(), end_at: end.toISOString(),
          }).select('id').single()
          if (cErr || !created) throw new Error('自動建立預設活動失敗')
          targetCampaign = (created as { id: string }).id
        }
        setForm((f) => ({ ...f, campaign_id: targetCampaign }))
      }
      const campaignId = targetCampaign
      if (editId) {
        const { data: cur } = await supabase.from('products').select('initial_stock, stock').eq('id', editId).single()
        const sold = cur ? Number(cur.initial_stock) - Number(cur.stock) : 0
        const newInitial = Number(form.initial_stock)
        const newStock = Math.max(0, newInitial - sold)
        if (newStock < newInitial - sold) throw new Error(`庫存不可低於已售數量（已售 ${sold} 件）`)
        const { error } = await supabase.from('products').update({
          campaign_id: campaignId, name: form.name, description: form.description || null,
          image_url: form.image_url || null, image_url_2: (form as unknown as { image_url_2?: string }).image_url_2 || null, image_url_3: (form as unknown as { image_url_3?: string }).image_url_3 || null, sku: form.sku, item_no: form.item_no.trim() || null,
          original_price: Number(form.original_price), minimum_price: Number(form.minimum_price),
          price_interval_seconds: Number(form.price_interval_seconds),
          price_decrease: Number(form.price_decrease),
          price_decrease_max: form.price_decrease_max ? Number(form.price_decrease_max) : null,
          initial_stock: newInitial, stock: newStock,
          max_per_customer: Number(form.max_per_customer),
          unit: form.unit.trim() || '件',
          items_per_unit: Math.max(1, Number(form.items_per_unit) || 1),
          sale_start_at: form.sale_start_at ? new Date(form.sale_start_at).toISOString() : (form._origSaleStartNull ? new Date().toISOString() : null),
          forced_delist_at: form.forced_delist_at ? new Date(form.forced_delist_at).toISOString() : null,
          status: form.status,
        }).eq('id', editId)
        if (error) throw new Error(error.message)
        setMsg('✅ 已儲存變更')
        await reloadProducts()
        setShowForm(false)
        navigate('/admin/products')
      } else {
        const { error: insertErr } = await supabase.from('products').insert({
          campaign_id: campaignId, name: form.name, description: form.description || null,
          image_url: form.image_url || null, image_url_2: (form as unknown as { image_url_2?: string }).image_url_2 || null, image_url_3: (form as unknown as { image_url_3?: string }).image_url_3 || null, sku: form.sku, item_no: form.item_no.trim() || null,
          original_price: Number(form.original_price), minimum_price: Number(form.minimum_price),
          price_interval_seconds: Number(form.price_interval_seconds),
          price_decrease: Number(form.price_decrease),
          price_decrease_max: form.price_decrease_max ? Number(form.price_decrease_max) : null,
          initial_stock: Number(form.initial_stock), stock: Number(form.initial_stock),
          max_per_customer: Number(form.max_per_customer),
          unit: form.unit.trim() || '件',
          items_per_unit: Math.max(1, Number(form.items_per_unit) || 1),
          sale_start_at: form.sale_start_at ? new Date(form.sale_start_at).toISOString() : new Date().toISOString(),
          forced_delist_at: form.forced_delist_at ? new Date(form.forced_delist_at).toISOString() : null,
          status: form.status,
        })
        if (insertErr) throw new Error(insertErr.message)
        if (form.scope !== 'all') {
          if (form.scope === 'companies') {
            const rows = form.company_ids.map((id) => ({ campaign_id: campaignId, company_id: id }))
            if (rows.length > 0) await supabase.from('campaign_companies').upsert(rows)
          } else {
            const rows = form.group_ids.map((id) => ({ campaign_id: campaignId, group_id: id }))
            if (rows.length > 0) await supabase.from('campaign_groups').upsert(rows)
          }
        }
        setMsg(duplicateMode ? '✅ 副本已建立（草稿狀態），確認內容後可發布' : '✅ 已新增商品')
        setForm(emptyForm)
        setShowForm(false)
        setDuplicateMode(false)
        await reloadProducts()
      }
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Product) => {
    const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('product_id', p.id)
    if ((count ?? 0) > 0) { setBlockedProduct({ p, orderCount: count ?? 0 }); return }
    if (!(await ask({ title: '刪除商品', message: `確定刪除商品「${p.name}」？\n此操作無法復原！`, danger: true }))) return
    await doDelete(p)
  }
  const doDelete = async (p: Product) => {
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('products').delete().eq('id', p.id)
      if (error) throw new Error(error.message.includes('foreign key') ? `「${p.name}」已有訂單紀錄，為保護對帳憑證無法刪除。可改用下方「改為已下架」。` : error.message)
      await reloadProducts()
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : '刪除失敗'}`) } finally { setBusy(false) }
  }
  const pauseInstead = async () => { if (!blockedProduct) return; await doPause(blockedProduct.p); setBlockedProduct(null) }
  const doPause = async (p: Product) => {
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('products').update({ status: 'ended' }).eq('id', p.id)
      if (error) throw error
      setMsg(`📦 已將「${p.name}」改為已下架——前台不再顯示，訂單紀錄完整保留`)
      await reloadProducts()
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : '操作失敗'}`) } finally { setBusy(false) }
  }
  const toggleStatus = async (p: Product) => {
    setBusy(true)
    await supabase.from('products').update({ status: p.status === 'active' ? 'ended' : 'active' }).eq('id', p.id)
    await reloadProducts()
    setBusy(false)
  }
  const relist = async (p: Product) => {
    const ok = await ask({
      title: '重新上架',
      message: `「${p.name}」將從原始價格 ${fmtMoney(Number(p.original_price))} 重新開始降價。\n庫存回補至 ${p.initial_stock}，現有訂單紀錄保留。\n確定重新上架？`,
      danger: false,
    })
    if (!ok) return
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('products').update({ status: 'active', sale_start_at: new Date().toISOString(), stock: p.initial_stock }).eq('id', p.id)
      if (error) throw error
      setMsg(`✅ 「${p.name}」已重新上架——從原始價格 ${fmtMoney(Number(p.original_price))} 開始降價`)
      await reloadProducts()
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : '操作失敗'}`) } finally { setBusy(false) }
  }
  const duplicateProduct = (p: Product) => {
    setDuplicateMode(true)
    navigate('/admin/products', { replace: true })
    setForm({
      campaign_id: p.campaign_id, name: `${p.name}（副本）`, description: p.description ?? '',
      image_url: p.image_url ?? '', image_url_2: (p as unknown as { image_url_2?: string }).image_url_2 ?? '', image_url_3: (p as unknown as { image_url_3?: string }).image_url_3 ?? '', sku: `${p.sku}-COPY`, item_no: (p as unknown as { item_no?: string }).item_no ?? '',
      original_price: String(p.original_price), minimum_price: String(p.minimum_price),
      price_interval_seconds: String(p.price_interval_seconds), price_decrease: String(p.price_decrease),
      price_decrease_max: p.price_decrease_max != null ? String(p.price_decrease_max) : '',
      initial_stock: String(p.initial_stock), max_per_customer: String(p.max_per_customer),
      unit: p.unit ?? '件', items_per_unit: String(p.items_per_unit ?? 1),
      sale_start_at: '', _origSaleStartNull: true,
      forced_delist_at: p.forced_delist_at ? toLocalInputValue(p.forced_delist_at) : '',
      status: 'draft', scope: 'all', company_ids: [], group_ids: [],
    })
    setShowForm(true)
    window.scrollTo({ top: 0 })
  }

  const inputCls = 'w-full h-11 px-3.5 rounded-xl border border-ink-200 bg-white text-[15px] text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400 transition'
  const labelCls = 'text-[13px] font-semibold text-ink-700'

  const counts: Record<StatusFilter, number> = {
    all: products.length,
    active: products.filter((x) => x.status === 'active').length,
    draft: products.filter((x) => x.status === 'draft').length,
    paused: products.filter((x) => x.status === 'paused').length,
    ended: products.filter((x) => x.status === 'ended').length,
  }

  return (
    <div className="space-y-4">
      {/* ── 頁首 ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink-900">商品管理</h1>
          <p className="mt-0.5 text-sm text-ink-500">設定販售商品、開賣時間與草稿 · 共 {products.length} 項</p>
        </div>
        {showForm ? (
          <button onClick={() => { setShowForm(false); setDuplicateMode(false); navigate('/admin/products', { replace: true }) }}
            className="h-10 px-4 rounded-xl border border-ink-200 bg-white text-sm font-semibold text-ink-700 hover:bg-ink-50 transition">
            取消
          </button>
        ) : (
          <button onClick={() => setShowForm(true)}
            className="h-10 px-5 rounded-xl bg-ink-900 text-white text-sm font-bold shadow-sm hover:bg-ink-800 active:scale-[0.98] transition">
            ＋ 新增商品
          </button>
        )}
      </div>

      {msg && (
        <div className="rounded-2xl border border-ink-200 bg-white px-4 py-3 text-sm text-center shadow-sm">
          {msg}
        </div>
      )}

      {/* ── 刪除被擋 Modal ── */}
      {blockedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" onClick={() => setBlockedProduct(null)}>
          <div className="w-full max-w-md bg-white rounded-2xl p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold text-ink-900">🔒 這個商品不能刪除</h2>
            <p className="mt-2 text-sm text-ink-600 leading-relaxed">
              「<span className="font-bold">{blockedProduct.p.name}</span>」已有 <span className="font-bold text-orange-600 tabular-nums">{blockedProduct.orderCount}</span> 筆訂單紀錄。訂單是對帳憑證，刪掉商品會讓歷史訂單失去連結，所以系統刻意保護它。
            </p>
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3">
              <p className="text-xs font-bold text-amber-700">建議做法</p>
              <p className="mt-1 text-xs text-ink-600 leading-relaxed">改為「已暫停」：前台立刻不顯示、不能再購買，訂單紀錄完整保留——效果跟刪除一樣，但帳目安全。</p>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <button onClick={() => void pauseInstead()} disabled={busy}
                className="h-11 rounded-xl bg-ink-900 text-white text-sm font-bold disabled:opacity-50">⏸ 改為已暫停（建議）</button>
              <button onClick={() => setBlockedProduct(null)}
                className="h-10 rounded-xl border border-ink-200 text-sm font-semibold text-ink-500">知道了</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 新增／編輯表單 ── */}
      {showForm && loaded && (
        <section className="bg-white rounded-2xl border border-ink-200 p-5 md:p-6 space-y-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold tracking-wide text-ink-900">
              {editId ? '編輯商品' : duplicateMode ? '複製商品（確認後建立）' : '新增商品'}
            </h2>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${STATUS_META[form.status].badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[form.status].dot}`} />{STATUS_META[form.status].label}
            </span>
          </div>

          <div className="grid gap-3">
            <input placeholder="商品名稱 *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input placeholder="SKU（例：SKU-COFFEE-01）*" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className={inputCls} />
              <input placeholder="商品品號（選填）" value={form.item_no} onChange={(e) => setForm({ ...form, item_no: e.target.value })} className={inputCls} />
            </div>
            <textarea placeholder="商品描述（選填）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${inputCls} h-20 py-2.5`} />
          </div>

          {/* 圖片 — 三張輪播 */}
          <div className="rounded-2xl border border-ink-200 bg-ink-50/60 p-4 space-y-4">
            <p className={labelCls}>商品圖片（最多 3 張，第 1 張為封面）</p>
            {[0,1,2].map((idx)=>{
              const key = idx===0?'image_url':`image_url_${idx+1}` as keyof typeof form
              const url = (form as unknown as Record<string,string>)[key] || ''
              const ref = idx===0?fileRef: idx===1?fileRef2: fileRef3
              const onPick = async (f: File|undefined)=>{
                if(!f) return; setUploading(true); setMsg(null)
                try{ const u=await uploadImage(f); setForm(prev=>({ ...prev, [key]: u } as typeof form)); setMsg(`✅ 圖${idx+1} 已上傳，記得按儲存`) }catch(e){ setMsg(`❌ ${e instanceof Error?e.message:'上傳失敗'}`) }finally{ setUploading(false) }
              }
              return (
                <div key={idx} className="rounded-xl border border-ink-200 bg-white p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink-700">圖 {idx+1} {idx===0 && <span className="text-[11px] font-normal text-ink-400">（封面）</span>}</span>
                    {url && <button type="button" onClick={()=> setForm(prev=>({ ...prev, [key]: '' } as typeof form))} className="text-xs text-red-500 hover:text-red-600">✕ 清除</button>}
                  </div>
                  {url ? <img src={url} alt={`圖${idx+1}`} className="w-full aspect-[4/3] max-h-60 object-cover rounded-xl border border-ink-200" /> : <div className="w-full aspect-[4/3] max-h-40 grid place-items-center rounded-xl border border-dashed border-ink-200 bg-ink-50 text-xs text-ink-400">尚未上傳</div>}
                  <div className="flex gap-2">
                    <button type="button" onClick={()=> ref.current?.click()} disabled={uploading} className="flex-1 h-9 rounded-xl bg-ink-900 text-white text-xs font-bold disabled:opacity-50">{uploading?'⏳ 上傳中…':'📷 上傳'}</button>
                    <input type="file" accept="image/*" ref={ref} className="hidden" onChange={e=>{ onPick(e.target.files?.[0]); e.target.value='' }} />
                  </div>
                  <input placeholder="或貼圖片 URL" value={url} onChange={e=> setForm(prev=>({ ...prev, [key]: e.target.value } as typeof form))} className={inputCls + ' h-9 text-sm'} />
                </div>
              )
            })}
          </div>

          {/* 價格與庫存 */}
          <div>
            <p className={`${labelCls} mb-2`}>價格與庫存</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">原價</span>
                <input type="number" min="0" value={form.original_price} onChange={(e) => setForm({ ...form, original_price: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">最低價格</span>
                <input type="number" min="0" value={form.minimum_price} onChange={(e) => setForm({ ...form, minimum_price: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">降價間隔（秒）</span>
                <input type="number" min="1" value={form.price_interval_seconds} onChange={(e) => setForm({ ...form, price_interval_seconds: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">每次降價（元）</span>
                <input type="number" min="0" value={form.price_decrease} onChange={(e) => setForm({ ...form, price_decrease: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">每次降價－最高</span>
                <input type="number" min="0" placeholder="留空＝固定" value={form.price_decrease_max} onChange={(e) => setForm({ ...form, price_decrease_max: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">初始庫存</span>
                <input type="number" min="0" value={form.initial_stock} onChange={(e) => setForm({ ...form, initial_stock: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">每人限購</span>
                <input type="number" min="1" value={form.max_per_customer} onChange={(e) => setForm({ ...form, max_per_customer: e.target.value })} className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-ink-500">銷售單位</span>
                <input value={form.unit} placeholder="件" onChange={(e) => setForm({ ...form, unit: e.target.value })} className={inputCls} />
              </label>
              <label className="col-span-2 sm:col-span-1 space-y-1.5">
                <span className="text-xs font-medium text-ink-500">單位入數</span>
                <input type="number" min="1" value={form.items_per_unit} onChange={(e) => setForm({ ...form, items_per_unit: e.target.value })} className={inputCls} />
              </label>
            </div>
          </div>

          <div className="grid gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-500">開賣時間（留空＝立即開始降價）</span>
              <input type="datetime-local" value={form.sale_start_at} onChange={(e) => setForm({ ...form, sale_start_at: e.target.value })} className={inputCls} />
              <span className="block text-xs text-ink-400">設為未來＝前台顯示「距開賣倒數」並鎖定下單。</span>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-500">強制下架時間（選填）</span>
              <input type="datetime-local" value={form.forced_delist_at} onChange={(e) => setForm({ ...form, forced_delist_at: e.target.value })} className={inputCls} />
              <span className="block text-xs text-ink-400">設為未來＝前台紅色「即將結束」倒數；留空＝不強制。</span>
            </label>
          </div>

          <div>
            <p className={`${labelCls} mb-2`}>商品狀態</p>
            <div className="grid grid-cols-3 gap-2">
              {(['active', 'draft', 'ended'] as const).map((s) => (
                <button key={s} onClick={() => setForm({ ...form, status: s })}
                  className={`h-11 rounded-xl text-sm font-bold ring-1 ring-inset transition ${form.status === s ? STATUS_META[s].badge : 'bg-white text-ink-500 ring-ink-200 hover:bg-ink-50'}`}>
                  {s === 'active' ? '販售中' : s==='ended' ? '已下架' : '草稿'}
                </button>
              ))}
            </div>
            {form.status === 'draft' && <p className="mt-2 text-xs text-amber-600">※ 草稿不會出現在前台，發布前請切回「販售中」。</p>}
          </div>

          <div className="rounded-2xl bg-ink-50 border border-ink-200 p-4 space-y-2">
            <p className="text-xs font-bold tracking-wide text-ink-600">參與促銷（唯讀）</p>
            {promoIds.length === 0 ? (
              <p className="text-xs text-ink-400">尚未參加任何活動。請到「促銷活動」編輯該活動的商品清單。</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {promoIds.map((pid) => {
                  const pro = promotions.find((x) => x.id === pid)
                  if (!pro) return null
                  return (
                    <span key={pid} className="inline-flex items-center gap-1 h-7 px-3 rounded-full bg-white border border-ink-200 text-xs font-semibold text-ink-700">
                      {(pro as { icon?: string | null }).icon || '🏷️'} {pro.name}
                    </span>
                  )
                })}
              </div>
            )}
            <p className="text-xs text-ink-400">🔒 排序統一在「促銷活動」頁管理，避免互相覆蓋。</p>
          </div>

          {!editId && (
            <div className="rounded-2xl bg-ink-50 border border-ink-200 p-4 space-y-3">
              <p className="text-xs font-bold tracking-wide text-ink-600">授權範圍</p>
              <div className="flex gap-2">
                {(['all', 'companies', 'groups'] as const).map((s) => (
                  <button key={s} onClick={() => setForm({ ...form, scope: s })}
                    className={`flex-1 h-9 rounded-full text-xs font-bold ring-1 ring-inset transition ${form.scope === s ? 'bg-ink-900 text-white ring-ink-900' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50'}`}>
                    {{ all: '全部客戶', companies: '指定公司', groups: '指定群組' }[s]}
                  </button>
                ))}
              </div>
              {form.scope === 'companies' && (
                <div className="grid gap-1.5 max-h-40 overflow-auto pr-1">
                  {companies.map((co) => (
                    <label key={co.id} className="flex items-center gap-2 text-sm text-ink-700 bg-white rounded-xl border border-ink-200 px-3 py-2">
                      <input type="checkbox" checked={form.company_ids.includes(co.id)}
                        onChange={(e) => setForm({ ...form, company_ids: e.target.checked ? [...form.company_ids, co.id] : form.company_ids.filter((x) => x !== co.id) })} />
                      {co.name}
                    </label>
                  ))}
                </div>
              )}
              {form.scope === 'groups' && (
                <div className="grid gap-1.5 max-h-40 overflow-auto pr-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm text-ink-700 bg-white rounded-xl border border-ink-200 px-3 py-2">
                      <input type="checkbox" checked={form.group_ids.includes(g.id)}
                        onChange={(e) => setForm({ ...form, group_ids: e.target.checked ? [...form.group_ids, g.id] : form.group_ids.filter((x) => x !== g.id) })} />
                      {g.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl bg-accent-50 border border-accent-200 px-4 py-3 text-sm text-ink-700 leading-relaxed">
            自動降價：{fmtMoney(Number(form.original_price))} 起，每 {formatInterval(Number(form.price_interval_seconds))} 降 {fmtMoney(Number(form.price_decrease))}{form.price_decrease_max ? `~${fmtMoney(Number(form.price_decrease_max))}` : ''}，最低 {fmtMoney(Number(form.minimum_price))}。
          </div>

          <button onClick={submit} disabled={busy || !form.name || !form.sku}
            className="w-full h-11 rounded-xl bg-ink-900 text-white text-sm font-bold shadow-sm hover:bg-ink-800 active:scale-[0.98] disabled:opacity-40 transition">
            {busy ? '儲存中…' : editId ? '儲存變更' : duplicateMode ? '建立副本' : '建立商品'}
          </button>
        </section>
      )}

      {/* ── 工具列：搜尋＋篩選（非表單模式） ── */}
      {!showForm && (
        <>
          <div className="bg-white rounded-2xl border border-ink-200 shadow-sm p-3 space-y-3">
            {/* 搜尋 */}
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 text-sm">⌕</span>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                inputMode="search"
                placeholder="搜尋商品、SKU、品號…"
                className="w-full h-11 pl-9 pr-4 rounded-xl border border-ink-200 bg-ink-50/60 text-[15px] placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400 transition"
              />
              {keyword && (
                <button onClick={() => setKeyword('')} className="absolute right-2 top-1/2 -translate-y-1/2 h-7 px-2.5 rounded-full bg-ink-900 text-white text-xs font-bold">清除</button>
              )}
            </div>
            {/* chips */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
              {(Object.entries({ all: '全部', active: '銷售中', draft: '草稿', ended: '已下架' }) as [StatusFilter, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  aria-pressed={statusFilter === key}
                  className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-xs font-bold ring-1 ring-inset transition ${statusFilter === key ? 'bg-ink-900 text-white ring-ink-900' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50'}`}
                >
                  {label}<span className={`tabular-nums rounded-full px-1.5 py-0.5 text-[11px] ${statusFilter === key ? 'bg-white/15 text-white' : 'bg-ink-100 text-ink-500'}`}>{counts[key]}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs text-ink-400">
              <span>顯示 {visibleProducts.length} / {products.length} 項{!showSoldout && products.some(p=>p.status==='ended'&&p.stock<=0) && ` · 已隱藏 ${products.filter(p=>p.status==='ended'&&p.stock<=0).length} 項已售完`}</span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-ink-600">
                <input type="checkbox" checked={showSoldout} onChange={e=>setShowSoldout(e.target.checked)} className="w-3.5 h-3.5 rounded border-ink-300 accent-ink-900" /> 顯示已售完
              </label>
            </div>
          </div>

          {/* ── 桌機：表格 ── */}
          <div className="hidden md:block bg-white rounded-2xl border border-ink-200 shadow-sm overflow-hidden">
            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-ink-50/90 backdrop-blur supports-[backdrop-filter]:bg-ink-50/80 border-b border-ink-200">
                  <tr className="text-left text-xs font-bold tracking-wide text-ink-500">
                    <th className="px-4 py-3 whitespace-nowrap">商品</th>
                    <th className="px-3 py-3 whitespace-nowrap">狀態</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right">價格</th>
                    <th className="px-3 py-3 whitespace-nowrap text-right">庫存</th>
                    <th className="px-3 py-3 whitespace-nowrap">降價</th>
                    <th className="px-4 py-3 whitespace-nowrap text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {visibleProducts.map((p) => (
                    <tr key={p.id} className="group hover:bg-ink-50/70 transition">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {p.image_url ? (
                            <img src={p.image_url} alt="" loading="lazy" decoding="async" className="h-11 w-11 rounded-xl object-cover border border-ink-100 shrink-0" />
                          ) : (
                            <div className="h-11 w-11 rounded-xl bg-ink-100 border border-ink-200 shrink-0 grid place-items-center text-ink-400">—</div>
                          )}
                          <div className="min-w-0">
                            <div className="font-semibold text-ink-900 truncate max-w-[22ch]">{p.name}</div>
                            <div className="text-xs text-ink-500 truncate">
                              {p.sku}{p.item_no ? ` · ${(p as unknown as { item_no: string }).item_no}` : ''} · 限購 {p.max_per_customer} {p.unit ?? '件'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3"><StatusBadge status={p.status} /></td>
                      <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">
                        <span className="font-semibold text-ink-900">{fmtMoney(Number(p.original_price))}</span>
                        <span className="text-ink-400"> → </span>
                        <span className="text-ink-600">{fmtMoney(Number(p.minimum_price))}</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span className={`font-bold ${Number(p.stock) <= 3 && p.status === 'active' ? 'text-red-600' : 'text-ink-900'}`}>{p.stock}</span>
                        <span className="text-ink-400"> / {p.initial_stock}</span>
                      </td>
                      <td className="px-3 py-3 text-xs text-ink-600 whitespace-nowrap">
                        每 {formatInterval(p.price_interval_seconds)} −{p.price_decrease_max != null && Number(p.price_decrease_max) !== Number(p.price_decrease) ? `${fmtMoney(Number(p.price_decrease))}~${fmtMoney(Number(p.price_decrease_max))}` : fmtMoney(Number(p.price_decrease))}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {/* 主要 */}
                          <div className="inline-flex rounded-xl border border-ink-200 overflow-hidden">
                            {(p.status === 'active' || p.status === 'draft') ? (
                              <button onClick={() => toggleStatus(p)} disabled={busy} className={`px-3 py-1.5 text-xs font-bold border-r border-ink-200 disabled:opacity-50 ${p.status==='active'?'bg-orange-50 text-orange-700 hover:bg-orange-100':'bg-white text-ink-700 hover:bg-ink-50'}`}>
                                {p.status === 'active' ? '📦 下架' : '▶ 發布'}
                              </button>
                            ) : (
                              <button onClick={() => void relist(p)} disabled={busy} className="px-3 py-1.5 bg-emerald-50 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 border-r border-ink-200">🔄 重新上架</button>
                            )}
                            <Link to={`/admin/products?id=${p.id}`} className="px-3 py-1.5 bg-white text-xs font-bold text-blue-700 hover:bg-blue-50">編輯</Link>
                          </div>
                          {/* 次要 */}
                          <div className="inline-flex rounded-xl border border-ink-200 overflow-hidden">
                            <button onClick={() => duplicateProduct(p)} disabled={busy} className="px-3 py-1.5 bg-white text-xs font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50">複製</button>
                          </div>
                          <button onClick={() => remove(p)} disabled={busy} className="h-7 px-2.5 rounded-full bg-red-50 text-red-600 border border-red-200 text-xs font-bold hover:bg-red-100 disabled:opacity-50">刪除</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleProducts.length === 0 && (
                <div className="py-10 text-center text-sm text-ink-400">{keyword ? '沒有符合搜尋的商品' : statusFilter === 'all' ? '尚無商品' : '此狀態沒有商品'}</div>
              )}
            </div>
          </div>

          {/* ── 手機：卡片（保留，視覺升級） ── */}
          <div className="md:hidden space-y-3">
            {visibleProducts.map((p) => (
              <div key={p.id} className="bg-white rounded-2xl border border-ink-200 p-4 shadow-sm hover:shadow-md hover:border-ink-300 transition">
                <div className="flex items-start gap-3">
                  {p.image_url ? (
                    <img src={p.image_url} alt="" loading="lazy" decoding="async" className="h-14 w-14 rounded-xl object-cover border border-ink-100 shrink-0" />
                  ) : (
                    <div className="h-14 w-14 rounded-xl bg-ink-100 border border-ink-200 shrink-0 grid place-items-center text-ink-400 text-xs">無圖</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-bold text-[15px] leading-tight text-ink-900 line-clamp-2">{p.name}</h3>
                      <StatusBadge status={p.status} />
                    </div>
                    <p className="mt-1 text-xs text-ink-500 truncate">{p.sku}{p.item_no ? ` · ${(p as unknown as { item_no:string }).item_no}` : ''} · 限購 {p.max_per_customer} {p.unit ?? '件'}</p>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-ink-50 border border-ink-100 p-3">
                  <div className="text-center">
                    <div className="text-[11px] font-bold tracking-wide text-ink-400">原價 → 最低</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-ink-900">{fmtMoney(Number(p.original_price))} <span className="text-ink-400 font-normal">→</span> {fmtMoney(Number(p.minimum_price))}</div>
                  </div>
                  <div className="text-center border-x border-ink-200">
                    <div className="text-[11px] font-bold tracking-wide text-ink-400">庫存</div>
                    <div className={`mt-0.5 text-sm font-bold tabular-nums ${Number(p.stock) <= 3 && p.status === 'active' ? 'text-red-600' : 'text-ink-900'}`}>{p.stock} <span className="font-normal text-ink-400">/ {p.initial_stock}</span></div>
                  </div>
                  <div className="text-center">
                    <div className="text-[11px] font-bold tracking-wide text-ink-400">降價</div>
                    <div className="mt-0.5 text-xs font-semibold text-ink-700 leading-tight">每 {formatInterval(p.price_interval_seconds)}<br />−{p.price_decrease_max != null && Number(p.price_decrease_max) !== Number(p.price_decrease) ? `${fmtMoney(Number(p.price_decrease))}~${fmtMoney(Number(p.price_decrease_max))}` : fmtMoney(Number(p.price_decrease))}</div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {/* 主要操作 */}
                  <div className="inline-flex rounded-xl overflow-hidden border border-ink-200">
                    {(p.status === 'active' || p.status === 'draft') ? (
                      <button onClick={() => toggleStatus(p)} disabled={busy} className={`px-3.5 py-2 text-sm font-bold disabled:opacity-50 ${p.status==='active'?'bg-orange-50 text-orange-700':'bg-white text-ink-700'}`}>
                        {p.status === 'active' ? '📦 下架' : '▶ 發布'}
                      </button>
                    ) : (
                      <button onClick={() => void relist(p)} disabled={busy} className="px-3.5 py-2 bg-emerald-50 text-sm font-bold text-emerald-700 disabled:opacity-50">🔄 重新上架</button>
                    )}
                    <Link to={`/admin/products?id=${p.id}`} className="px-3.5 py-2 bg-white border-l border-ink-200 text-sm font-bold text-blue-700 hover:bg-blue-50">✏️ 編輯</Link>
                  </div>
                  <div className="inline-flex rounded-xl overflow-hidden border border-ink-200">
                    <button onClick={() => duplicateProduct(p)} disabled={busy} className="px-3.5 py-2 bg-white text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">⧉ 複製</button>
                  </div>
                  <button onClick={() => remove(p)} disabled={busy} className="px-3.5 py-2 rounded-xl bg-red-50 text-red-600 border border-red-200 text-sm font-bold hover:bg-red-100 disabled:opacity-50">🗑</button>
                </div>
              </div>
            ))}
            {visibleProducts.length === 0 && (
              <div className="bg-white rounded-2xl border border-dashed border-ink-200 p-8 text-center text-sm text-ink-400">
                {keyword ? '沒有符合搜尋的商品' : statusFilter === 'all' ? '尚無商品' : '此狀態沒有商品'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
