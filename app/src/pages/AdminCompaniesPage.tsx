import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Company } from '../lib/types'
import { fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'

export default function AdminCompaniesPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [companies, setCompanies] = useState<Company[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null) // null=新增模式
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive'>('active')

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async () => {
    const { data } = await supabase
      .from('companies')
      .select('*')
      .order('created_at', { ascending: true })
    if (data) setCompanies(data as Company[])
  }
  useEffect(() => { load() }, [])

  const openCreate = () => {
    setEditingId(null)
    setName(''); setNote(''); setStatus('active')
    setShowForm((v) => !v)
    setMsg(null)
  }

  const openEdit = (c: Company & { status?: string }) => {
    setEditingId(c.id)
    setShowForm(true)
    setMsg(null)
    setName(c.name)
    setNote(c.note ?? '')
    setStatus(c.status === 'inactive' ? 'inactive' : 'active')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      if (editingId) {
        // ---------- 編輯 ----------
        const { error } = await supabase
          .from('companies')
          .update({ name: name.trim(), note: note || null, status })
          .eq('id', editingId)
        if (error) {
          throw new Error(error.message.includes('duplicate') ? '公司名稱已存在' : error.message)
        }
        setMsg('✅ 公司已更新')
      } else {
        // ---------- 新增 ----------
        const { error } = await supabase.from('companies').insert({
          name: name.trim(), note: note || null,
        })
        if (error) throw new Error(error.message.includes('duplicate') ? '公司名稱已存在' : error.message)
        setMsg('✅ 公司已新增')
      }
      setName(''); setNote(''); setStatus('active')
      setShowForm(false); setEditingId(null)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  /** 刪除公司（兩段確認；有客戶或活動綁定時 DB 會擋） */
  const remove = async (c: Company & { status?: string }) => {
    if (!window.confirm(`確定要刪除「${c.name}」嗎？`)) return
    if (!window.confirm(`⚠️ 若此公司底下還有客戶或綁定中的活動，刪除會被系統拒絕。\n建議先將客戶轉移或改用「停用」。仍要刪除嗎？`)) return

    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('companies').delete().eq('id', c.id)
      if (error) {
        throw new Error(
          error.message.includes('foreign key') || error.message.includes('violates')
            ? '此公司仍有客戶或活動綁定，無法刪除（請先轉移，或改用停用）'
            : error.message,
        )
      }
      setMsg('✅ 公司已刪除')
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '刪除失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const toggleStatus = async (c: Company & { status?: string }) => {
    setBusy(true)
    const next = c.status === 'inactive' ? 'active' : 'inactive'
    await supabase.from('companies').update({ status: next }).eq('id', c.id)
    await load()
    setBusy(false)
  }

  const inputCls =
    'w-full h-11 px-3 rounded-xl border border-ink-200 bg-white text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-400'

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white border-b border-ink-100 px-5 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <Link to="/admin" className="w-9 h-9 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-600" aria-label="返回">
            ←
          </Link>
          <h1 className="text-base font-bold text-ink-900">公司管理</h1>
          <button onClick={openCreate} className="text-xs font-semibold text-accent-600">
            {showForm && editingId === null ? '收起' : '＋ 新增'}
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-4">
        {/* 表單（新增 / 編輯共用） */}
        {showForm && (
          <section className={`bg-white rounded-2xl border p-5 space-y-3 shadow-sm anim-fade-up ${editingId ? 'border-accent-300' : 'border-ink-100'}`}>
            <h2 className="text-sm font-bold text-ink-900">
              {editingId ? '✏️ 編輯公司' : '新增公司'}
            </h2>
            <input placeholder="公司名稱（例：公司 A）" value={name}
              onChange={(e) => setName(e.target.value)} className={inputCls} />
            <input placeholder="備註（選填）" value={note}
              onChange={(e) => setNote(e.target.value)} className={inputCls} />
            {editingId && (
              <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
                className={inputCls}>
                <option value="active">啟用</option>
                <option value="inactive">停用</option>
              </select>
            )}
            <div className="flex gap-2">
              <button onClick={submit} disabled={busy || !name.trim()}
                className="flex-1 h-11 rounded-xl bg-ink-900 text-white text-sm font-semibold disabled:opacity-40">
                {busy ? '儲存中…' : editingId ? '儲存變更' : '建立公司'}
              </button>
              <button onClick={() => { setShowForm(false); setEditingId(null); setName(''); setNote('') }}
                className="px-4 h-11 rounded-xl border border-ink-200 text-sm font-medium text-ink-600">
                取消
              </button>
            </div>
            {msg && <p className="text-xs text-center text-ink-600">{msg}</p>}
          </section>
        )}
        {!showForm && msg && (
          <p className="text-xs text-center bg-white border border-ink-100 rounded-xl py-2.5 shadow-sm">{msg}</p>
        )}

        <section className="space-y-3">
          {companies.map((c) => {
            const co = c as Company & { status?: string }
            return (
              <div key={c.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-ink-900">{c.name}</h3>
                    {c.note && <p className="mt-0.5 text-xs text-ink-400">{c.note}</p>}
                    <p className="mt-0.5 text-xs text-ink-300">
                      建立於 {c.created_at ? fmtDateTime(c.created_at) : '—'}
                    </p>
                  </div>
                  <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
                    co.status !== 'inactive' ? 'bg-green-50 text-green-700' : 'bg-ink-100 text-ink-500'
                  }`}>
                    {co.status !== 'inactive' ? '啟用' : '停用'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <button onClick={() => toggleStatus(co)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-ink-100 text-ink-700 text-xs font-medium disabled:opacity-50">
                    {co.status !== 'inactive' ? '⏸ 停用' : '▶ 啟用'}
                  </button>
                  <span className="flex-1" />
                  <button onClick={() => openEdit(co)}
                    className="px-3 py-1.5 rounded-lg bg-ink-100 text-ink-700 text-xs font-medium">
                    ✏️ 編輯
                  </button>
                  <button onClick={() => remove(co)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-red-50 text-red-500 text-xs font-medium disabled:opacity-50">
                    🗑 刪除
                  </button>
                </div>
              </div>
            )
          })}
          {companies.length === 0 && (
            <p className="text-center text-sm text-ink-400 py-8">尚無公司</p>
          )}
        </section>
      </main>
    </div>
  )
}
