import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmDialog'

type Promo = {
  id: string
  name: string
  description: string | null
  starts_at: string
  ends_at: string
  is_active: boolean
  kind: string
  status?: 'draft' | 'active'
  items?: { product_id: string; products?: { name: string; sku: string } | null }[]
}

/** 活動狀態：未開始／進行中／已結束 */
function promoPhase(p: { starts_at: string; ends_at: string }): 'upcoming' | 'running' | 'ended' {
  const now = Date.now()
  if (new Date(p.starts_at).getTime() > now) return 'upcoming'
  if (new Date(p.ends_at).getTime() < now) return 'ended'
  return 'running'
}

const PHASE_LABEL = { upcoming: '排程中', running: '進行中', ended: '已結束' } as const
const PHASE_STYLE = {
  upcoming: 'bg-blue-50 text-blue-700',
  running: 'bg-green-50 text-green-700',
  ended: 'bg-ink-100 text-ink-500',
} as const

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-ink-200 bg-white text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-400"

/** datetime-local 值 → ISO（台北時間語義由瀏覽器處理） */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AdminPromotionsPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const ask = useConfirm()
  const [promos, setPromos] = useState<Promo[]>([])
  const [products, setProducts] = useState<{ id: string; name: string; sku: string }[]>([])
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const emptyForm = {
    name: '', description: '', kind: 'flash',
    icon: '', sort_order: '0',
    starts_at: toLocalInputValue(new Date().toISOString()),
    ends_at: toLocalInputValue(new Date(Date.now() + 7 * 86400_000).toISOString()),
    product_ids: [] as string[],
    asDraft: true,
  }
  const [form, setForm] = useState(emptyForm)
  const [editId, setEditId] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/login', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async () => {
    const [{ data: promos }, { data: products }] = await Promise.all([
      supabase.from('promotions').select('*, promotion_items(product_id, products(name, sku))').order('created_at', { ascending: false }),
      supabase.from('products').select('id, name, sku').eq('status', 'active').order('created_at', { ascending: false }),
    ])
    if (promos) setPromos(promos as Promo[])
    if (products) setProducts(products as { id: string; name: string; sku: string }[])
  }
  useEffect(() => { load() }, [])

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      const draft = form.asDraft
      if (!form.name.trim()) throw new Error('請填寫活動名稱')
      if (!draft) {
        if (form.product_ids.length === 0) throw new Error('請至少選擇一個商品')
        if (new Date(form.ends_at) <= new Date(form.starts_at)) throw new Error('結束時間必須晚於開始時間')
      }

      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        starts_at: new Date(form.starts_at).toISOString(),
        ends_at: new Date(form.ends_at).toISOString(),
        status: draft ? ('draft' as const) : ('active' as const),
        kind: form.kind ?? 'flash',
        icon: form.icon.trim() || null,
        sort_order: Math.max(0, Number(form.sort_order) || 0),
      }

      let promoId = editId
      if (editId) {
        const { error } = await supabase.from('promotions').update(payload).eq('id', editId)
        if (error) throw error
        await supabase.from('promotion_items').delete().eq('promotion_id', editId)
      } else {
        const { data, error } = await supabase.from('promotions').insert(payload).select('id').single()
        if (error) throw error
        promoId = data.id
      }

      const { error: itemErr } = await supabase.from('promotion_items').insert(
        form.product_ids.map((pid, i) => ({ promotion_id: promoId, product_id: pid, sort_order: i })),
      )
      if (itemErr) throw itemErr

      setMsg(editId ? '✅ 活動已更新' : '✅ 活動已建立')
      setShowForm(false)
      setEditId(null)
      setForm(emptyForm)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const startEdit = async (p: Promo) => {
    setEditId(p.id)
    setForm({
      name: p.name,
      description: p.description ?? '',
      icon: (p as { icon?: string | null }).icon ?? '',
      sort_order: String((p as { sort_order?: number }).sort_order ?? 0),
      starts_at: toLocalInputValue(p.starts_at),
      ends_at: toLocalInputValue(p.ends_at),
      product_ids: (p.items ?? []).map((i) => i.product_id),
      kind: (p as { kind?: string }).kind ?? 'flash',
      asDraft: p.status === 'draft',
    })
    setShowForm(true)
    window.scrollTo({ top: 0 })
  }

  const toggleActive = async (p: Promo) => {
    setBusy(true)
    if (p.status === 'draft') {
      await supabase.from('promotions').update({ status: 'active', is_active: true }).eq('id', p.id)
    } else {
      await supabase.from('promotions').update({ is_active: !p.is_active }).eq('id', p.id)
    }
    await load()
    setBusy(false)
  }

  const remove = async (p: Promo) => {
    if (!(await ask({ title: '刪除活動', message: `確定刪除活動「${p.name}」嗎？`, danger: true }))) return
    setBusy(true)
    await supabase.from('promotions').delete().eq('id', p.id)
    await load()
    setBusy(false)
  }

  const toggleProduct = (id: string) => {
    setForm((f) => ({
      ...f,
      product_ids: f.product_ids.includes(id)
        ? f.product_ids.filter((x) => x !== id)
        : [...f.product_ids, id],
    }))
  }

  return (
      <main className="space-y-4">
        {/* 標題列＋新增 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-ink-900">促銷活動</h1>
            <p className="text-xs md:text-sm text-ink-400">限時促銷與草稿發布</p>
            <p className="mt-2 flex items-start gap-1.5 text-xs md:text-sm text-ink-500 bg-accent-50 border border-accent-100 rounded-lg px-3 py-2">
              <span aria-hidden="true">ℹ️</span>
              <span>活動僅用於商品展示與行銷分類，不影響商品價格、庫存、上下架及降價規則。</span>
            </p>
          </div>
          <button onClick={() => setShowForm(true)}
            className="h-10 px-4 rounded-xl bg-ink-900 text-white text-sm font-semibold active:scale-[0.98] transition">
            ＋ 新增活動
          </button>
        </div>

        {msg && (
          <div role="alert" className={`rounded-xl border px-4 py-2.5 text-xs anim-pop-in ${msg.startsWith('✅') ? 'bg-green-50 border-green-100 text-green-700' : 'bg-red-50 border-red-100 text-red-600'}`}>
            {msg}
          </div>
        )}

        {/* 新增／編輯表單 */}
        {showForm && (
          <section className="bg-white rounded-2xl border border-ink-100 p-5 space-y-3 shadow-sm">
            <h2 className="text-sm font-bold text-ink-900">{editId ? '編輯活動' : '新增活動'}</h2>
            {/* 儲存狀態：草稿 / 發布 */}
            <div className="flex gap-2">
              {(['draft', 'publish'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setForm({ ...form, asDraft: m === 'draft' })}
                  className={`flex-1 h-10 rounded-xl text-xs font-medium ${
                    form.asDraft === (m === 'draft')
                      ? m === 'draft' ? 'bg-amber-50 text-amber-700 border border-amber-300' : 'bg-green-50 text-green-700 border border-green-200'
                      : 'border border-ink-200 text-ink-400'
                  }`}>
                  {m === 'draft' ? '📝 存成草稿' : '🚀 直接發布'}
                </button>
              ))}
            </div>
            {form.asDraft && (
              <p className="text-xs text-amber-600">※ 草稿活動不會出現在任何前台頁面，可先暫存未完成的內容，之後再發布。</p>
            )}
            <input placeholder="活動名稱（例：中秋禮盒特賣）" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <input placeholder="🔥 圖示" value={form.icon} maxLength={4}
                onChange={(e) => setForm({ ...form, icon: e.target.value })} className={inputCls} />
              <label className="flex items-center gap-2 text-xs text-ink-500">
                顯示排序
                <input type="number" min="0" value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                  className="flex-1 px-3 py-2.5 rounded-xl border border-ink-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-400" />
                <span className="whitespace-nowrap">數字小＝顯示在前面</span>
              </label>
            </div>
            <textarea placeholder="活動說明（選填）" rows={2} value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl border border-ink-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-400" />
            <p className="text-xs text-ink-400">
              ℹ️ 活動僅用於商品展示與行銷分類，不影響商品價格、庫存、上下架及降價規則。
            </p>
            {/* 活動類型 */}
            <label className="block text-xs text-ink-500">
              活動類型
              <select value={form.kind ?? 'flash'} onChange={(e) => setForm({ ...form, kind: e.target.value })}
                className="w-full px-3 py-2.5 rounded-xl border border-ink-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-400 mt-1">
                <option value="flash">⚡ Flash 限時場</option>
                <option value="accel">🚀 加速場（更快降到底）</option>
                <option value="bundle">📦 組合場</option>
                <option value="clearance">🏷️ 清倉場</option>
                <option value="focus">⭐ 焦點新品</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="block text-[11px] text-ink-400 mb-1">開始日期與時間</span>
                <input type="datetime-local" value={form.starts_at}
                  onChange={(e) => setForm({ ...form, starts_at: e.target.value })} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-[11px] text-ink-400 mb-1">結束日期與時間</span>
                <input type="datetime-local" value={form.ends_at}
                  onChange={(e) => setForm({ ...form, ends_at: e.target.value })} className={inputCls} />
              </label>
            </div>

            {/* 商品多選 */}
            <div>
              <span className="block text-[11px] text-ink-400 mb-1">活動商品（可複選，已選 {form.product_ids.length} 項）</span>
              <div className="max-h-48 overflow-y-auto rounded-xl border border-ink-100 divide-y divide-ink-50">
                {products.length === 0 && (
                  <p className="px-3 py-3 text-xs text-ink-400">目前沒有可選商品，請先到「商品」上架</p>
                )}
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-ink-50">
                    <input type="checkbox" checked={form.product_ids.includes(p.id)}
                      onChange={() => toggleProduct(p.id)}
                      className="w-4 h-4 accent-[var(--accent-500,#e07a3f)]" />
                    <span className="flex-1 min-w-0 text-sm text-ink-900 truncate">{p.name}</span>
                    <span className="text-[10px] text-ink-400 shrink-0">{p.sku}</span>
                  </label>
                ))}
              </div>
            </div>

            <button onClick={submit} disabled={busy}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white
                         text-sm font-bold shadow-md shadow-accent-500/25 active:scale-[0.99] transition disabled:opacity-50">
              {busy ? '儲存中…' : form.asDraft ? (editId ? '更新草稿' : '儲存草稿') : (editId ? '發布活動' : '建立並發布')}
            </button>
          </section>
        )}

        {/* 活動列表 */}
        {promos.length === 0 && !showForm && (
          <div className="text-center py-16 anim-fade-up">
            <div className="text-4xl mb-3">🏷️</div>
            <p className="text-sm text-ink-400">還沒有促銷活動</p>
          </div>
        )}
        {promos.map((p, i) => {
          const phase = promoPhase(p)
          const itemCount = p.items?.length ?? 0
          return (
            <div key={p.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm anim-fade-up"
              style={{ animationDelay: `${Math.min(i * 50, 200)}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink-900">{p.name}</h3>
                  <p className="mt-0.5 text-[11px] text-ink-400 tabular-nums">
                    {new Date(p.starts_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    ～
                    {new Date(p.ends_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  {p.status === 'draft' ? (
                    <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">📝 草稿</span>
                  ) : (
                    <>
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${PHASE_STYLE[phase]}`}>
                        {PHASE_LABEL[phase]}
                      </span>
                      {!p.is_active && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-500">已停用</span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <p className="mt-1.5 text-xs text-ink-500">🎁 {itemCount} 項商品</p>

              <div className="mt-3 flex gap-1.5">
                <button onClick={() => startEdit(p)}
                  className="px-3 py-1.5 rounded-lg bg-accent-50 text-accent-700 text-xs font-medium">
                  ✏️ 編輯
                </button>
                <button onClick={() => toggleActive(p)} disabled={busy}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${p.status === 'draft' ? 'bg-green-50 text-green-700' : p.is_active ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                  {p.status === 'draft' ? '🚀 發布' : p.is_active ? '⏸ 停用' : '▶ 啟用'}
                </button>
                <button onClick={() => remove(p)} disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium disabled:opacity-50">
                  🗑 刪除
                </button>
              </div>
            </div>
          )
        })}
      </main>
  )
}
