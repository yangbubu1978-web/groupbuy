import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Campaign } from '../lib/types'
import { useAuth } from '../context/AuthContext'

export default function AdminCampaignNewPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('id') // 有值 = 編輯模式
  const wantsDanger = window.location.hash.includes('#danger') // 後台「🗑 刪除」進入

  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const toLocalInput = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const [form, setForm] = useState({
    name: '',
    description: '',
    start_at: toLocalInput(new Date(Date.now() + 3600_000)),
    end_at: toLocalInput(new Date(Date.now() + 3 * 24 * 3600_000)),
    status: 'draft' as Campaign['status'],
  })
  const [loaded, setLoaded] = useState(!editId)

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  // 編輯模式：載入既有活動
  useEffect(() => {
    if (!editId) { setLoaded(true); return }
    ;(async () => {
      const { data } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', editId)
        .maybeSingle()
      if (data) {
        const c = data as Campaign
        const loc = (iso: string) => {
          const d = new Date(iso)
          return toLocalInput(new Date(d.getTime() - d.getTimezoneOffset() * 60000))
        }
        setForm({
          name: c.name,
          description: c.description ?? '',
          start_at: loc(c.start_at),
          end_at: loc(c.end_at),
          status: c.status,
        })
      }
      setLoaded(true)
    })()
  }, [editId])

  // 後台「🗑 刪除」進入：載入完成後自動捲到危險區並閃一下提示
  useEffect(() => {
    if (loaded && editId && wantsDanger) {
      requestAnimationFrame(() => {
        document.getElementById('danger')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  }, [loaded, editId, wantsDanger])

  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        start_at: new Date(form.start_at).toISOString(),
        end_at: new Date(form.end_at).toISOString(),
        status: form.status,
      }
      const { error } = editId
        ? await supabase.from('campaigns').update(payload).eq('id', editId)
        : await supabase.from('campaigns').insert(payload)
      if (error) throw new Error(error.message)
      navigate('/admin')
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editId) return
    if (!window.confirm('確定刪除此活動？\n活動下的商品也會一併刪除，且無法復原！')) return
    if (!window.confirm('再次確認：真的要刪除嗎？（若活動已有訂單，系統會拒絕刪除）')) return
    setBusy(true); setMsg(null)
    try {
      const { error } = await supabase.from('campaigns').delete().eq('id', editId)
      if (error) throw new Error(error.message.includes('foreign key')
        ? '此活動已有訂單，無法刪除。請改用「已取消」或「已結束」狀態。'
        : error.message)
      navigate('/admin')
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '刪除失敗'}`)
      setBusy(false)
    }
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
          <h1 className="text-base font-bold text-ink-900">{editId ? '編輯活動' : '新增活動'}</h1>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-4">
        {!loaded && (
          <p className="text-center text-sm text-ink-400 py-16">載入中…</p>
        )}
        {loaded && (
          <>
            <section className="bg-white rounded-2xl border border-ink-100 p-5 space-y-3 shadow-sm">
              <input placeholder="活動名稱" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
              <textarea placeholder="活動說明（選填）" value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className={`${inputCls} h-20 py-2`} />

              <label className="block text-xs text-ink-500">
                開始時間
                <input type="datetime-local" value={form.start_at}
                  onChange={(e) => setForm({ ...form, start_at: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>
              <label className="block text-xs text-ink-500">
                結束時間
                <input type="datetime-local" value={form.end_at}
                  onChange={(e) => setForm({ ...form, end_at: e.target.value })}
                  className={`${inputCls} mt-1`} />
              </label>

              <label className="block text-xs text-ink-500">
                活動狀態
                <select value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as Campaign['status'] })}
                  className={`${inputCls} mt-1`}>
                  <option value="draft">草稿</option>
                  <option value="scheduled">已排程</option>
                  <option value="active">進行中</option>
                  <option value="ended">已結束</option>
                  <option value="cancelled">已取消</option>
                </select>
              </label>

              {!editId && (
                <p className="text-xs text-ink-400 leading-relaxed">
                  活動授權範圍（指定公司／群組／個別客戶）可在新增商品時設定；
                  不指定即代表全部客戶皆可參加。
                </p>
              )}

              <button onClick={submit} disabled={busy || !form.name}
                className="w-full h-11 rounded-xl bg-ink-900 text-white text-sm font-semibold disabled:opacity-40">
                {busy ? '儲存中…' : editId ? '儲存變更' : '建立活動'}
              </button>
              {msg && <p className="text-xs text-center text-ink-600">{msg}</p>}
            </section>

            {/* 危險區：僅編輯模式 */}
            {editId && (
              <section id="danger" className={`bg-white rounded-2xl border p-5 shadow-sm ${wantsDanger ? 'border-red-300 ring-2 ring-red-200' : 'border-red-100'}`}>
                <h2 className="text-xs font-bold text-red-600 mb-2">危險操作</h2>
                <button onClick={remove} disabled={busy}
                  className="w-full h-11 rounded-xl border border-red-200 bg-red-50 text-red-600 text-sm font-semibold disabled:opacity-40">
                  🗑 刪除此活動
                </button>
                <p className="mt-2 text-[11px] text-ink-400 leading-relaxed">
                  已產生訂單的活動無法刪除（保障交易紀錄），請改將狀態設為「已取消」。
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
