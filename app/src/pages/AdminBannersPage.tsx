import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Banner } from '../lib/types'
import { fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'

/** 後台：首頁看板管理（上傳圖片、點擊連結、排序、啟用） */
export default function AdminBannersPage() {
  const { isAdmin, loading: authLoading, userId } = useAuth()
  const navigate = useNavigate()
  const [banners, setBanners] = useState<Banner[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // 表單（新增／編輯共用）
  const emptyForm = { id: null as string | null, title: '', target_url: '', sort_order: '0', is_active: true, image_url: '' }
  const [form, setForm] = useState(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isAdminUser = useRef(false)

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async () => {
    const { data } = await supabase
      .from('banners')
      .select('*')
      .order('sort_order', { ascending: true })
    if (data) setBanners(data as Banner[])
  }
  useEffect(() => { load() }, [])

  const uploadImage = async (file: File): Promise<string> => {
    // 管理員驗證（RLS 政策需要 admins 表有此 user）
    if (userId) {
      const { data: a } = await supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle()
      isAdminUser.current = !!a
      if (!a) throw new Error('僅管理員可上傳圖片')
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png'
    const path = `banners/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
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

  const save = async () => {
    if (!form.image_url) {
      setMsg('❌ 請先上傳圖片')
      return
    }
    setBusy(true); setMsg(null)
    try {
      const payload = {
        title: form.title.trim() || null,
        image_url: form.image_url,
        target_url: form.target_url.trim() || null,
        sort_order: Number(form.sort_order) || 0,
        is_active: form.is_active,
      }
      const { error } = form.id
        ? await supabase.from('banners').update(payload).eq('id', form.id)
        : await supabase.from('banners').insert(payload)
      if (error) throw new Error(error.message)
      setMsg(form.id ? '✅ 看板已更新' : '✅ 看板已新增')
      setForm(emptyForm); setShowForm(false)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (b: Banner) => {
    if (!window.confirm(`確定刪除看板「${b.title ?? '未命名'}」？`)) return
    setBusy(true); setMsg(null)
    const { error } = await supabase.from('banners').delete().eq('id', b.id)
    if (error) setMsg(`❌ 刪除失敗：${error.message}`)
    else setMsg('🗑 已刪除')
    await load()
    setBusy(false)
  }

  const toggleActive = async (b: Banner) => {
    setBusy(true)
    await supabase.from('banners').update({ is_active: !b.is_active }).eq('id', b.id)
    await load()
    setBusy(false)
  }

  const inputCls =
    'w-full h-11 px-3 rounded-xl border border-ink-200 bg-white text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-400'

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white border-b border-ink-100 px-5 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <Link to="/admin" className="w-9 h-9 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-600" aria-label="返回">←</Link>
          <h1 className="text-base font-bold text-ink-900">首頁看板</h1>
          <button onClick={() => { setForm(emptyForm); setShowForm((v) => !v) }} className="text-xs font-semibold text-accent-600">
            {showForm ? '收起' : '＋ 新增'}
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-4">
        {showForm && (
          <section className="bg-white rounded-2xl border border-ink-100 p-5 space-y-3 shadow-sm">
            <h2 className="text-sm font-bold text-ink-900">{form.id ? '✏️ 編輯看板' : '新增看板'}</h2>

            {/* 圖片上傳 */}
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])} />
            {form.image_url ? (
              <div className="relative">
                <img src={form.image_url} alt="預覽" className="w-full aspect-square object-cover rounded-xl border border-ink-100" />
                <button onClick={() => fileRef.current?.click()} disabled={uploading}
                  className="absolute bottom-2 right-2 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-black/55 text-white">
                  {uploading ? '上傳中…' : '更換圖片'}
                </button>
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="w-full h-24 rounded-xl border-2 border-dashed border-ink-200 text-sm text-ink-400
                           flex items-center justify-center disabled:opacity-50">
                {uploading ? '上傳中…' : '📷 點擊上傳圖片（建議 1:1（例 1200×1200））'}
              </button>
            )}

            <input placeholder="標題（選填，顯示在圖片下方）" value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} />
            <input placeholder="點擊連結（選填，例：https://...）" value={form.target_url}
              onChange={(e) => setForm({ ...form, target_url: e.target.value })} className={inputCls} />
            <div className="flex gap-3">
              <input placeholder="排序（數字越小越前面）" inputMode="numeric" value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: e.target.value.replace(/\D/g, '') })}
                className={`${inputCls} flex-1`} />
              <label className="flex items-center gap-2 text-xs text-ink-600 px-2">
                <input type="checkbox" checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                啟用
              </label>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={busy || uploading || !form.image_url}
                className="flex-1 h-11 rounded-xl bg-ink-900 text-white text-sm font-semibold disabled:opacity-40">
                {busy ? '儲存中…' : '儲存'}
              </button>
              <button onClick={() => { setShowForm(false); setForm(emptyForm) }} disabled={busy}
                className="h-11 px-4 rounded-xl bg-ink-100 text-ink-600 text-sm font-medium disabled:opacity-50">
                取消
              </button>
            </div>
          </section>
        )}

        {msg && <p className="text-xs text-center bg-white border border-ink-100 rounded-xl py-2.5 shadow-sm">{msg}</p>}

        {/* 看板列表 */}
        <section className="space-y-3">
          {banners.map((b) => (
            <div key={b.id} className={`bg-white rounded-2xl border border-ink-100 overflow-hidden shadow-sm ${!b.is_active ? 'opacity-60' : ''}`}>
              <img src={b.image_url} alt={b.title ?? ''} className="w-full aspect-square object-cover" />
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-ink-900">{b.title ?? '未命名看板'}</h3>
                    <p className="mt-0.5 text-[11px] text-ink-300">
                      排序 {b.sort_order} · 建立於 {b.created_at ? fmtDateTime(b.created_at) : '—'}
                    </p>
                    {b.target_url && <p className="mt-0.5 text-[11px] text-accent-600 truncate">{b.target_url}</p>}
                  </div>
                  <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
                    b.is_active ? 'bg-green-50 text-green-700' : 'bg-ink-100 text-ink-500'
                  }`}>
                    {b.is_active ? '顯示中' : '已隱藏'}
                  </span>
                </div>
                <div className="mt-3 flex gap-1.5">
                  <button onClick={() => { setForm({ id: b.id, title: b.title ?? '', target_url: b.target_url ?? '', sort_order: String(b.sort_order), is_active: b.is_active, image_url: b.image_url }); setShowForm(true); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    className="px-3 py-1.5 rounded-lg bg-accent-50 text-accent-700 text-xs font-medium">
                    ✏️ 編輯
                  </button>
                  <button onClick={() => toggleActive(b)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-ink-100 text-ink-700 text-xs font-medium disabled:opacity-50">
                    {b.is_active ? '⏸ 隱藏' : '▶ 顯示'}
                  </button>
                  <button onClick={() => remove(b)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium disabled:opacity-50">
                    🗑 刪除
                  </button>
                </div>
              </div>
            </div>
          ))}
          {banners.length === 0 && (
            <p className="text-center text-sm text-ink-400 py-8">尚無看板，點右上角「＋ 新增」建立第一張</p>
          )}
        </section>
      </main>
    </div>
  )
}
