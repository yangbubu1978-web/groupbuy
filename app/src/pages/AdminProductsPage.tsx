import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign, Company, CustomerGroup, Product, Promotion } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { formatInterval } from '../lib/pricing'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmDialog'

/** datetime-local 值 ↔ ISO（台北時間語義由瀏覽器處理） */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AdminProductsPage() {
  const { isAdmin, loading: authLoading, userId } = useAuth()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isAdminUser = useRef(false)
  const ask = useConfirm()

  // 商品圖上傳 → Supabase Storage（media bucket，免費圖床）
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

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    setUploading(true); setMsg(null)
    try {
      const url = await uploadImage(file)
      setForm((f) => ({ ...f, image_url: url }))
      setMsg('✅ 圖片已上傳，記得按儲存')
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '上傳失敗'}`)
    } finally {
      setUploading(false)
    }
  }
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('id') // 有值 = 編輯模式

  const [products, setProducts] = useState<Product[]>([])
  // 活動欄位已從表活動欄位已從表單移除：僅在背景抓第一個活動 ID 自動帶入
  const [, setCampaigns] = useState<Campaign[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [groups, setGroups] = useState<CustomerGroup[]>([])
  const [showForm, setShowForm] = useState(!!editId)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(!editId)

  // 表單欄位
  const emptyForm = {
    campaign_id: '', name: '', description: '', image_url: '', sku: '',
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

  // 促銷活動（商品 ↔ 多個促銷）
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [promoIds, setPromoIds] = useState<string[]>([])

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
        // 活動已從表單移除：自動帶入第一個活動
        setForm((f) => (f.campaign_id ? f : { ...f, campaign_id: (cs[0]?.id ?? '') }))
      }
      if (cos) setCompanies(cos as Company[])
      if (gs) setGroups(gs as CustomerGroup[])
      if (prs) setPromotions(prs as Promotion[])
    })()
  }, [])

  // 編輯模式：載入既有商品
  useEffect(() => {
    if (!editId) { setLoaded(true); return }
    setShowForm(true)
    ;(async () => {
      const { data } = await supabase
        .from('products')
        .select('*')
        .eq('id', editId)
        .maybeSingle()
      if (data) {
        const p = data as Product
        setForm({
          campaign_id: p.campaign_id,
          name: p.name,
          description: p.description ?? '',
          image_url: p.image_url ?? '',
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
        // 載入商品已參與的促銷
        const { data: items } = await supabase
          .from('promotion_items').select('promotion_id').eq('product_id', editId)
        if (items) setPromoIds(items.map((i) => i.promotion_id))
      }
      setLoaded(true)
    })()
  }, [editId])

  const reloadProducts = async () => {
    const { data } = await supabase
      .from('products').select('*').order('created_at', { ascending: false })
    if (data) setProducts(data as Product[])
  }

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      // 沒有任何活動時，自動建立一個「預設活動」承接商品
      let targetCampaign = form.campaign_id
      if (!targetCampaign) {
        const { data: existing } = await supabase
          .from('campaigns').select('id').limit(1)
        if (existing && existing.length > 0) {
          targetCampaign = (existing[0] as { id: string }).id
        } else {
          const now = new Date()
          const start = new Date(now.getTime() - 3600_000)
          const end = new Date(now.getTime() + 365 * 86400_000)
          const { data: created, error: cErr } = await supabase
            .from('campaigns')
            .insert({
              name: '預設活動',
              description: '系統自動建立',
              status: 'active',
              start_at: start.toISOString(),
              end_at: end.toISOString(),
            })
            .select('id')
            .single()
          if (cErr || !created) throw new Error('自動建立預設活動失敗')
          targetCampaign = (created as { id: string }).id
        }
        setForm((f) => ({ ...f, campaign_id: targetCampaign }))
      }
      const campaignId = targetCampaign
      if (editId) {
        // ---------- 編輯 ----------
        // 庫存調整規則：新庫存不得低於（初始 − 已售）
        const { data: cur } = await supabase
          .from('products').select('initial_stock, stock').eq('id', editId).single()
        const sold = cur ? Number(cur.initial_stock) - Number(cur.stock) : 0
        const newInitial = Number(form.initial_stock)
        const newStock = Math.max(0, newInitial - sold)
        if (newStock < newInitial - sold) {
          throw new Error(`庫存不可低於已售數量（已售 ${sold} 件）`)
        }

        const { error } = await supabase.from('products').update({
          campaign_id: campaignId,
          name: form.name,
          description: form.description || null,
          image_url: form.image_url || null,
          sku: form.sku,
          item_no: form.item_no.trim() || null,
          original_price: Number(form.original_price),
          minimum_price: Number(form.minimum_price),
          price_interval_seconds: Number(form.price_interval_seconds),
          price_decrease: Number(form.price_decrease),
          price_decrease_max: form.price_decrease_max ? Number(form.price_decrease_max) : null,
          initial_stock: newInitial,
          stock: newStock,
          max_per_customer: Number(form.max_per_customer),
          unit: form.unit.trim() || '件',
          items_per_unit: Math.max(1, Number(form.items_per_unit) || 1),
          // 開賣時間留空＝自動以現在開始降價（杜絕「永遠原價」幽靈商品）
          sale_start_at: form.sale_start_at
            ? new Date(form.sale_start_at).toISOString()
            : (form._origSaleStartNull ? new Date().toISOString() : null),
          forced_delist_at: form.forced_delist_at ? new Date(form.forced_delist_at).toISOString() : null,
          status: form.status,
        }).eq('id', editId)
        if (error) throw new Error(error.message)
        // 同步促銷關聯（商品 ↔ 促銷）
        await supabase.from('promotion_items').delete().eq('product_id', editId)
        if (promoIds.length > 0) {
          await supabase.from('promotion_items').insert(
            promoIds.map((promotion_id) => ({ promotion_id, product_id: editId as string, sort_order: 0 }))
          )
        }
        setMsg('✅ 已儲存變更')
        await reloadProducts()
        setShowForm(false)
        navigate('/admin/products')
      } else {
        // ---------- 新增 ----------
        const { data: created, error: insertErr } = await supabase.from('products').insert({
          campaign_id: campaignId,
          name: form.name,
          description: form.description || null,
          image_url: form.image_url || null,
          sku: form.sku,
          item_no: form.item_no.trim() || null,
          original_price: Number(form.original_price),
          minimum_price: Number(form.minimum_price),
          price_interval_seconds: Number(form.price_interval_seconds),
          price_decrease: Number(form.price_decrease),
          price_decrease_max: form.price_decrease_max ? Number(form.price_decrease_max) : null,
          initial_stock: Number(form.initial_stock),
          stock: Number(form.initial_stock),
          max_per_customer: Number(form.max_per_customer),
          unit: form.unit.trim() || '件',
          items_per_unit: Math.max(1, Number(form.items_per_unit) || 1),
          // 開賣時間留空＝自動以現在開始降價
          sale_start_at: form.sale_start_at ? new Date(form.sale_start_at).toISOString() : new Date().toISOString(),
          forced_delist_at: form.forced_delist_at ? new Date(form.forced_delist_at).toISOString() : null,
          status: form.status,
        }).select('id').single()
        if (insertErr) throw new Error(insertErr.message)
        const newProductId = (created as { id: string }).id

        // 授權範圍寫入對應表
        if (form.scope !== 'all') {
          if (form.scope === 'companies') {
            const rows = form.company_ids.map((id) => ({ campaign_id: campaignId, company_id: id }))
            if (rows.length > 0) await supabase.from('campaign_companies').upsert(rows)
          } else {
            const rows = form.group_ids.map((id) => ({ campaign_id: campaignId, group_id: id }))
            if (rows.length > 0) await supabase.from('campaign_groups').upsert(rows)
          }
        }
        // 同步促銷關聯（商品 ↔ 促銷）
        if (promoIds.length > 0) {
          await supabase.from('promotion_items').insert(
            promoIds.map((promotion_id) => ({ promotion_id, product_id: newProductId, sort_order: 0 }))
          )
        }
        setMsg('✅ 已新增商品')
        setForm(emptyForm)
        setShowForm(false)
        await reloadProducts()
      }
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Product) => {
    if (!(await ask({ title: '刪除商品', message: `確定刪除商品「${p.name}」？\n此操作無法復原！`, danger: true }))) return
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('products').delete().eq('id', p.id)
      if (error) throw new Error(error.message.includes('foreign key')
        ? '此商品已有訂單，無法刪除。建議將狀態改為「已暫停」。'
        : error.message)
      await reloadProducts()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '刪除失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const toggleStatus = async (p: Product) => {
    setBusy(true)
    await supabase.from('products').update({
      status: p.status === 'active' ? 'paused' : 'active',
    }).eq('id', p.id)
    await reloadProducts()
    setBusy(false)
  }

  const inputCls =
    'w-full h-12 px-3 rounded-xl border border-ink-200 bg-white text-base text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-400'

  return (
    <main className="space-y-4">
        {/* 標題列＋新增 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-ink-900">商品管理</h1>
            <p className="text-sm md:text-base text-ink-500">設定販售商品、開賣時間與草稿</p>
          </div>
          {showForm ? (
            <button onClick={() => setShowForm(false)}
              className="h-10 px-4 rounded-xl border border-ink-200 bg-white text-sm font-medium text-ink-600">
              取消
            </button>
          ) : (
            <button onClick={() => setShowForm(true)}
              className="h-10 px-4 rounded-xl bg-ink-900 text-white text-sm font-semibold transition">
              ＋ 新增商品
            </button>
          )}
        </div>

        {msg && <p className="text-sm text-center bg-white border border-ink-100 rounded-xl py-2.5 shadow-sm">{msg}</p>}

        {/* 新增／編輯表單 */}
        {showForm && loaded && (
          <section className="bg-white rounded-2xl border border-ink-100 p-5 space-y-3 shadow-sm">
            <h2 className="text-sm font-bold text-ink-900">{editId ? '編輯商品' : '新增商品'}</h2>

            <input placeholder="商品名稱" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <input placeholder="SKU（例：SKU-COFFEE-01）" value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })} className={inputCls} />
            <input placeholder="商品品號（選填，例：PG-1001）" value={form.item_no}
              onChange={(e) => setForm({ ...form, item_no: e.target.value })} className={inputCls} />
            <textarea placeholder="商品描述（選填）" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className={`${inputCls} h-20 py-2`} />
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                  className="flex-1 text-sm font-semibold bg-accent-50 text-accent-700 border border-accent-200 rounded-xl py-2.5 active:scale-[0.98] disabled:opacity-50">
                  {uploading ? '⏳ 上傳中…' : '📷 上傳商品照片'}
                </button>
                {form.image_url && (
                  <button type="button" onClick={() => setForm({ ...form, image_url: '' })}
                    className="text-xs text-ink-400 underline py-2.5">清除</button>
                )}
              </div>
              <input type="file" accept="image/*" ref={fileRef} className="hidden"
                onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = '' }} />
              {form.image_url && (
                <img src={form.image_url} alt="商品圖預覽"
                  className="w-full aspect-square object-cover rounded-xl border border-ink-100" />
              )}
              <input placeholder="或貼圖片 URL（選填）" value={form.image_url}
                onChange={(e) => setForm({ ...form, image_url: e.target.value })} className={inputCls} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm text-ink-600">
                原價
                <input type="number" min="0" value={form.original_price}
                  onChange={(e) => setForm({ ...form, original_price: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-600">
                最低價格
                <input type="number" min="0" value={form.minimum_price}
                  onChange={(e) => setForm({ ...form, minimum_price: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-600">
                降價間隔（秒，2 小時＝7200）
                <input type="number" min="1" value={form.price_interval_seconds}
                  onChange={(e) => setForm({ ...form, price_interval_seconds: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm text-ink-600">
                  每次降價－最低（元）
                  <input type="number" min="0" value={form.price_decrease}
                    onChange={(e) => setForm({ ...form, price_decrease: e.target.value })}
                    className={`${inputCls} mt-1`} />
                </label>
                <label className="text-sm text-ink-600">
                  每次降價－最高（元）
                  <input type="number" min="0" placeholder="留空＝固定" value={form.price_decrease_max}
                    onChange={(e) => setForm({ ...form, price_decrease_max: e.target.value })}
                    className={`${inputCls} mt-1`} />
                </label>
              </div>
              <label className="text-sm text-ink-600">
                初始庫存
                <input type="number" min="0" value={form.initial_stock}
                  onChange={(e) => setForm({ ...form, initial_stock: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-600">
                每人限購
                <input type="number" min="1" value={form.max_per_customer}
                  onChange={(e) => setForm({ ...form, max_per_customer: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-600">
                銷售單位（例：箱、件）
                <input value={form.unit} placeholder="件"
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-600">
                單位入數（1 單位 = ? 件）
                <input type="number" min="1" value={form.items_per_unit}
                  onChange={(e) => setForm({ ...form, items_per_unit: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
            </div>

            {/* 開賣時間（選填；留空＝立即上架） */}
            <label className="block text-xs text-ink-500">
              開賣時間（留空＝立即開始降價；設為未來＝「即將開賣」）
              <input type="datetime-local" value={form.sale_start_at}
                onChange={(e) => setForm({ ...form, sale_start_at: e.target.value })}
                className={`${inputCls} mt-1`} />
              <span className="mt-1 block text-xs text-ink-500">
                ※ 設為未來的時間，前台會顯示「⏳ 距開賣倒數」並鎖定不可下單，時間一到自動開賣；留空＝系統自動以儲存當下開始降價。
              </span>
            </label>

            {/* 強制下架時間（選填；設為未來＝「即將結束」） */}
            <label className="block text-xs text-ink-500">
              強制下架時間（選填；設為未來＝「即將結束」）
              <input type="datetime-local" value={form.forced_delist_at}
                onChange={(e) => setForm({ ...form, forced_delist_at: e.target.value })}
                className={`${inputCls} mt-1`} />
              <span className="mt-1 block text-xs text-ink-500">
                ※ 前台會顯示紅色「⏳ 即將結束」倒數標章；時間一到系統每分鐘自動下架收檔。留空＝不強制（由降價到底機制決定）。
              </span>
            </label>

            {/* 商品狀態（含草稿） */}
            <div>
              <p className="text-xs font-medium text-ink-600 mb-1.5">商品狀態</p>
              <div className="flex gap-2">
                {(['active', 'paused', 'draft'] as const).map((s) => (
                  <button key={s} onClick={() => setForm({ ...form, status: s })}
                    className={`flex-1 h-10 rounded-xl text-sm font-semibold ${
                      form.status === s
                        ? s === 'draft'
                          ? 'bg-amber-50 text-amber-700 border border-amber-300'
                          : s === 'active' ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-ink-100 text-ink-700 border border-ink-200'
                        : 'border border-ink-200 text-ink-400'
                    }`}>
                    {s === 'active' ? '販售中' : s === 'paused' ? '已暫停' : '📝 草稿'}
                  </button>
                ))}
              </div>
              {form.status === 'draft' && (
                <p className="mt-1.5 text-xs text-amber-600">
                  ※ 草稿商品不會出現在任何前台頁面，發布前請切回「販售中」。
                </p>
              )}
            </div>

            {/* 參與促銷活動（商品 ↔ 促銷多選） */}
            <div className="rounded-xl bg-ink-50 p-3 space-y-2">
              <p className="text-sm font-semibold text-ink-600">加入促銷活動（可多選）</p>
              {promotions.length === 0 ? (
                <p className="text-xs text-ink-400">尚無促銷活動，可先到「🏷️ 促銷活動」建立。</p>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto">
                  {promotions.map((pro) => (
                    <label key={pro.id} className="flex items-center gap-2 text-sm text-ink-700">
                      <input type="checkbox" checked={promoIds.includes(pro.id)}
                        onChange={(e) =>
                          setPromoIds(e.target.checked
                            ? [...promoIds, pro.id]
                            : promoIds.filter((x) => x !== pro.id))
                        } />
                      <span>{pro.name}</span>
                      <span className="ml-auto text-xs text-ink-500">
                        {pro.status === 'draft' ? '📝 草稿' : pro.is_active ? '啟用中' : '已停用'}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* 授權範圍（僅新增模式） */}
            {!editId && (
              <div className="rounded-xl bg-ink-50 p-3 space-y-2">
                <p className="text-sm font-semibold text-ink-600">活動授權範圍</p>
                <div className="flex gap-3 text-xs">
                  {(['all', 'companies', 'groups'] as const).map((s) => (
                    <label key={s} className="flex items-center gap-1.5">
                      <input type="radio" checked={form.scope === s}
                        onChange={() => setForm({ ...form, scope: s })} />
                      {{ all: '全部客戶', companies: '指定公司', groups: '指定群組' }[s]}
                    </label>
                  ))}
                </div>
                {form.scope === 'companies' && (
                  <div className="space-y-1">
                    {companies.map((co) => (
                      <label key={co.id} className="flex items-center gap-2 text-sm text-ink-700">
                        <input type="checkbox" checked={form.company_ids.includes(co.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              company_ids: e.target.checked
                                ? [...form.company_ids, co.id]
                                : form.company_ids.filter((x) => x !== co.id),
                            })
                          } />
                        {co.name}
                      </label>
                    ))}
                  </div>
                )}
                {form.scope === 'groups' && (
                  <div className="space-y-1">
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 text-sm text-ink-700">
                        <input type="checkbox" checked={form.group_ids.includes(g.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              group_ids: e.target.checked
                                ? [...form.group_ids, g.id]
                                : form.group_ids.filter((x) => x !== g.id),
                            })
                          } />
                        {g.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 預覽 */}
            <div className="rounded-xl bg-accent-50 border border-accent-100 p-3 text-sm text-ink-600 leading-relaxed">
              系統將自動降價：{fmtMoney(Number(form.original_price))} 起，
              每 {formatInterval(Number(form.price_interval_seconds))} 隨機降 {fmtMoney(Number(form.price_decrease))} ~ {form.price_decrease_max ? fmtMoney(Number(form.price_decrease_max)) : fmtMoney(Number(form.price_decrease))}，
              最低 {fmtMoney(Number(form.minimum_price))}。
              {editId && (
                <span className="block mt-1 text-ink-400">
                  ※ 編輯庫存時：新庫存 = 新初始庫存 − 已售數量（不影響既有訂單）
                </span>
              )}
            </div>

            <button onClick={submit} disabled={busy || !form.name || !form.sku}
              className="w-full h-11 rounded-xl bg-ink-900 text-white text-base font-bold disabled:opacity-40">
              {busy ? '儲存中…' : editId ? '儲存變更' : '建立商品'}
            </button>
          </section>
        )}

        {/* 商品列表 */}
        {!showForm && (
          <section className="space-y-3">
            {products.map((p) => (
              <div key={p.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-ink-900">{p.name}</h3>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {p.sku} · 每人限購 {p.max_per_customer} {p.unit ?? '件'}
                      {Number(p.items_per_unit) > 1 ? `（1 ${p.unit}＝${p.items_per_unit} 件）` : ''}
                    </p>
                  </div>
                  <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
                    p.status === 'active'
                      ? 'bg-green-50 text-green-700'
                      : p.status === 'draft'
                        ? 'bg-amber-50 text-amber-700'
                        : p.status === 'ended'
                          ? 'bg-orange-50 text-orange-600'
                          : 'bg-ink-100 text-ink-500'
                  }`}>
                    {p.status === 'active' ? '銷售中' : p.status === 'draft' ? '📝 草稿' : p.status === 'ended' ? '超時未售出' : '已暫停'}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-ink-600">
                  <span>原價 {fmtMoney(Number(p.original_price))}</span>
                  <span>最低 {fmtMoney(Number(p.minimum_price))}</span>
                  <span>每 {formatInterval(p.price_interval_seconds)} −{p.price_decrease_max != null && Number(p.price_decrease_max) !== Number(p.price_decrease) ? `${fmtMoney(Number(p.price_decrease))}~${fmtMoney(Number(p.price_decrease_max))}` : fmtMoney(Number(p.price_decrease))}</span>
                </div>
                <div className="mt-1.5 text-sm">
                  庫存：<span className="font-bold text-ink-900">{p.stock}</span> / {p.initial_stock}
                </div>

                {/* 操作列 */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button onClick={() => toggleStatus(p)} disabled={busy}
                    className="px-3.5 py-2 rounded-lg bg-ink-100 text-ink-700 text-sm font-semibold disabled:opacity-50">
                    {p.status === 'active' ? '⏸ 暫停販售' : p.status === 'draft' ? '▶ 發布' : '▶ 恢復販售'}
                  </button>
                  <Link to={`/admin/products?id=${p.id}`}
                    className="px-3.5 py-2 rounded-lg bg-blue-50 text-blue-700 text-sm font-semibold">
                    ✏️ 編輯
                  </Link>
                  <button onClick={() => remove(p)} disabled={busy}
                    className="px-3.5 py-2 rounded-lg bg-red-50 text-red-600 text-sm font-semibold disabled:opacity-50">
                    🗑 刪除
                  </button>
                </div>
              </div>
            ))}
            {products.length === 0 && (
              <p className="text-center text-sm text-ink-400 py-8">尚無商品</p>
            )}
          </section>
        )}
      </main>
  )
}
