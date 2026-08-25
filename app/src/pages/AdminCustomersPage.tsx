import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Company, Customer, CustomerGroup } from '../lib/types'
import { fmtDateTime } from '../lib/types'
import { useAuth } from '../context/AuthContext'
import { useCustomerImport } from '../lib/customerImport'
import { ImportResultPanel } from '../lib/customerImportPanel'
import { useConfirm } from '../components/ConfirmDialog'

const STATUS_LABEL: Record<string, string> = {
  active: '啟用', inactive: '停用', blocked: '封鎖',
}
const STATUS_STYLE: Record<string, string> = {
  active: 'bg-green-50 text-green-700',
  inactive: 'bg-ink-100 text-ink-500',
  blocked: 'bg-red-50 text-red-600',
}

/** 呼叫 admin Edge Function（共用 headers） */
async function callAdminFn(body: Record<string, unknown>) {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  const fnBase = import.meta.env.VITE_SUPABASE_URL as string
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  const res = await fetch(`${fnBase}/functions/v1/admin`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

export default function AdminCustomersPage() {
  const { isAdmin, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [groups, setGroups] = useState<CustomerGroup[]>([])
  const [adminIds, setAdminIds] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const emptyForm = {
    name: '', phone: '', password: '',
    company_id: '', group_id: '', status: 'active' as Customer['status'],
    createAuth: true,
  }
  const [form, setForm] = useState(emptyForm)

  // ---------- 編輯狀態 ----------
  const [editId, setEditId] = useState<string | null>(null)
  const emptyEdit = {
    name: '', phone: '', originalPhone: '', originalName: '',
    company_id: '', group_id: '',
    status: 'active' as Customer['status'],
    newPassword: '', hasAuth: false,
  }
  const [editForm, setEditForm] = useState(emptyEdit)
  const ask = useConfirm()

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/', { replace: true })
  }, [authLoading, isAdmin, navigate])

  const load = async () => {
    const [{ data: cs }, { data: cos }, { data: gs }, { data: admins }] = await Promise.all([
      supabase.from('customers').select('*').order('created_at', { ascending: false }),
      supabase.from('companies').select('*'),
      supabase.from('customer_groups').select('*'),
      supabase.from('admins').select('user_id'),
    ])
    if (cs) setCustomers(cs as Customer[])
    if (cos) setCompanies(cos as Company[])
    if (gs) setGroups(gs as CustomerGroup[])
    if (admins) {
      const ids = new Set(admins.map((a: { user_id: string }) => a.user_id))
      setAdminIds(ids)
    }
  }
  useEffect(() => { load() }, [])
  const { fileRef, importing, result, downloadTemplate, importFile, setResult } = useCustomerImport(load)

  // ---------- 新增 ----------
  const submit = async () => {
    setBusy(true); setMsg(null)
    try {
      let authUserId: string | null = null
      const normalizedPhone = form.phone.trim() ? form.phone.replace(/\D/g, '') : ''

      // 1. 建立 auth 帳號（透過 admin Edge Function）— 手機可空白（方案 A）
      if (form.createAuth) {
        const data = await callAdminFn({
          action: 'createAuthUser',
          phone: normalizedPhone || undefined,
          password: form.password || '888888', // 企劃書：預設密碼 888888
          name: form.name.trim(),
        })
        if (!data?.ok) throw new Error(data?.reason === 'exists' ? '此手機號碼已有帳號' : data?.reason === 'bad_request' ? '手機格式不正確' : '建立帳號失敗')
        authUserId = data.userId
      }

      // 2. 寫入白名單（有建帳號 → 標記首次登入強制改密碼）
      const { error } = await supabase.from('customers').insert({
        name: form.name.trim(),
        phone: normalizedPhone || null,
        company_id: form.company_id,
        group_id: form.group_id || null,
        status: form.status,
        auth_user_id: authUserId,
        must_change_password: !!authUserId,
      })
      if (error) throw new Error(error.message)

      setMsg(authUserId ? (normalizedPhone ? '✅ 客戶已新增（預設密碼 888888，首登強制改密）' : '✅ 客戶已新增（僅姓名，手機待會員自助補填，預設密碼 888888）') : '✅ 客戶已新增')
      setForm(emptyForm)
      setShowForm(false)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '新增失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 編輯 ----------
  const startEdit = (c: Customer) => {
    setEditId(c.id)
    setEditForm({
      name: c.name,
      phone: c.phone ?? '',
      originalPhone: c.phone ?? '',
      originalName: c.name,
      company_id: c.company_id,
      group_id: c.group_id ?? '',
      status: c.status,
      newPassword: '',
      hasAuth: !!c.auth_user_id,
    })
    setMsg(null)
  }

  const saveEdit = async () => {
    if (!editId) return
    setBusy(true); setMsg(null)
    try {
      const phoneChanged = editForm.phone !== editForm.originalPhone
      const nameChanged = editForm.name !== editForm.originalName

      // 1. 同步更新登入帳號（改名／手機／密碼）
      if (editForm.hasAuth && (phoneChanged || nameChanged || editForm.newPassword)) {
        const data = await callAdminFn({
          action: 'updateAuthUser',
          phone: editForm.originalPhone,
          newPhone: phoneChanged ? editForm.phone : undefined,
          newName: nameChanged ? editForm.name : undefined,
          newPassword: editForm.newPassword || undefined,
        })
        if (!data?.ok) {
          const reasonMsg: Record<string, string> = {
            phone_exists: '新手機號碼已被其他帳號使用',
            weak_password: '新密碼至少需要 6 碼',
            invalid_new_phone: '新手機格式不正確',
            not_found: '找不到對應的登入帳號',
          }
          throw new Error(reasonMsg[data?.reason] ?? '更新登入帳號失敗')
        }
      }

      // 2. 更新白名單資料
      const { error } = await supabase.from('customers').update({
        name: editForm.name.trim(),
        phone: editForm.phone,
        company_id: editForm.company_id,
        group_id: editForm.group_id || null,
        status: editForm.status,
      }).eq('id', editId)
      if (error) {
        throw new Error(
          error.message.includes('duplicate') || error.code === '23505'
            ? '此手機號碼已存在於白名單'
            : error.message,
        )
      }

      setMsg('✅ 客戶資料已更新')
      setEditId(null)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '更新失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 刪除 ----------
  const removeCustomer = async (c: Customer) => {
    if (!(await ask({ title: '刪除客戶', message: `確定刪除客戶「${c.name}（${c.phone}）」？\n此操作無法復原！`, danger: true }))) return
    if (!(await ask({ title: '刪除客戶', message: `最後確認：真的要刪除「${c.name}」嗎？\n※ 若此客戶已有訂單紀錄，刪除會被系統拒絕（建議改為「封鎖」）。`, danger: true }))) return
    setBusy(true); setMsg(null)
    try {
      // 1. 刪除登入帳號（沒綁帳號則略過；帳號本來就不存在也算成功）
      if (c.auth_user_id) {
        const data = await callAdminFn({ action: 'deleteAuthUser', phone: c.phone })
        if (!data?.ok && data?.reason !== 'not_found') {
          throw new Error('刪除登入帳號失敗，已中止操作')
        }
      }
      // 2. 刪除白名單
      const { error } = await supabase.from('customers').delete().eq('id', c.id)
      if (error) {
        if (error.code === '23503' || error.message.includes('foreign key')) {
          throw new Error('此客戶已有訂單紀錄，無法刪除。建議將狀態改為「封鎖」，以保留完整的交易紀錄。')
        }
        throw new Error(error.message)
      }
      setMsg(`🗑 已刪除客戶「${c.name}」`)
      if (editId === c.id) setEditId(null)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : '刪除失敗'}`)
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (id: string, status: string) => {
    await supabase.from('customers').update({ status }).eq('id', id)
    await load()
  }

  // 指派／撤銷管理員（總管理功能，走 Edge Function）
  const toggleAdmin = async (c: Customer) => {
    const make = c.auth_user_id ? !adminIds.has(c.auth_user_id) : false
    if (
      !make &&
      !(await ask({ title: '取消管理員', message: `確定要取消「${c.name}」的管理員資格嗎？`, danger: true }))
    ) return
    setBusy(true)
    try {
      const data = await callAdminFn({ action: 'setAdmin', customerId: c.id, makeAdmin: make })
      if (!data.ok) throw new Error(data.reason === 'cannot_demote_self' ? '不能取消自己的管理員資格' : data.reason)
      await load()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '操作失敗')
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'w-full h-11 px-3 rounded-xl border border-ink-200 bg-white text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-400'

  const companyName = (id: string) => companies.find((co) => co.id === id)?.name ?? '—'
  const groupName = (id: string | null) =>
    id ? groups.find((g) => g.id === id)?.name : null

  const editValid =
    editForm.name.trim() !== '' &&
    (editForm.phone === '' || /^09\d{8}$/.test(editForm.phone)) &&
    editForm.company_id !== '' &&
    (editForm.newPassword === '' || editForm.newPassword.length >= 6)

  return (
    <main className="space-y-4">
        {/* 標題列＋操作 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-ink-900">客戶管理</h1>
            <p className="text-xs md:text-sm text-ink-400">白名單、帳號與權限重設</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) importFile(e.target.files[0]); e.target.value = '' }} />
            <button onClick={downloadTemplate}
              className="h-10 px-3 rounded-xl border border-ink-200 bg-white text-sm font-medium text-ink-600">範本</button>
            <button onClick={() => fileRef.current?.click()} disabled={importing}
              className="h-10 px-3 rounded-xl border border-ink-200 bg-white text-sm font-medium text-ink-600 disabled:opacity-50">
              {importing ? '匯入中…' : '⇧ 匯入'}
            </button>
            {!showForm && (
              <button onClick={() => setShowForm(true)}
                className="h-10 px-3 rounded-xl bg-ink-900 text-white text-sm font-semibold">＋ 新增客戶</button>
            )}
          </div>
        </div>

        {result && <ImportResultPanel result={result} onClose={() => setResult(null)} />}
        {showForm && (
          <section className="bg-white rounded-2xl border border-ink-100 p-5 space-y-3 shadow-sm">
            <h2 className="text-sm font-bold text-ink-900">新增客戶（白名單）</h2>
            <input placeholder="姓名（必填）" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <input placeholder="手機號碼（選填，09XXXXXXXX，空白可後補）" inputMode="numeric" value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '') })}
              className={inputCls} />
            {form.phone && !/^09\d{8}$/.test(form.phone) && (
              <p className="text-[11px] text-amber-600">⚠ 手機格式應為 09 開頭 10 碼，或留空由會員登入後補填</p>
            )}
            <label className="flex items-center gap-2 text-xs text-ink-600">
              <input type="checkbox" checked={form.createAuth}
                onChange={(e) => setForm({ ...form, createAuth: e.target.checked })} />
              同時建立登入帳號
            </label>
            {form.createAuth && (
              <input placeholder="初始密碼（至少 6 碼）" value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputCls} />
            )}
            <select value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value, group_id: '' })}
              className={inputCls}>
              <option value="">選擇公司…</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}
              className={inputCls}>
              <option value="">選擇群組（選填）…</option>
              {groups.filter((g) => !g.company_id || g.company_id === form.company_id)
                .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Customer['status'] })}
              className={inputCls}>
              <option value="active">啟用</option>
              <option value="inactive">停用</option>
              <option value="blocked">封鎖</option>
            </select>

            <button onClick={submit}
              disabled={busy || !form.name.trim() ||
                (form.phone !== '' && !/^09\d{8}$/.test(form.phone)) ||
                (form.createAuth && form.password.length > 0 && form.password.length < 6) || !form.company_id}
              className="w-full h-11 rounded-xl bg-ink-900 text-white text-sm font-semibold disabled:opacity-40">
              {busy ? '儲存中…' : '建立客戶'}
            </button>
          </section>
        )}

        {msg && <p className="text-xs text-center bg-white border border-ink-100 rounded-xl py-2.5 shadow-sm">{msg}</p>}

        {/* 客戶列表 */}
        <section className="space-y-3">
          {customers.map((c) => (
            <div key={c.id} className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-ink-900">{c.name}</h3>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {c.phone ? c.phone : <span className="text-amber-600">⚠ 尚未填寫手機</span>} · 最後登入 {c.last_login_at ? fmtDateTime(c.last_login_at) : '從未'}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {companyName(c.company_id)}
                    {groupName(c.group_id) ? ` · ${groupName(c.group_id)}` : ''}
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLE[c.status]}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                  {c.auth_user_id && adminIds.has(c.auth_user_id) && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ink-900 text-white">
                      ★ 管理員
                    </span>
                  )}
                </div>
              </div>

              {/* 操作列 */}
              <div className="mt-3 flex items-center justify-between gap-1.5">
                <div className="flex gap-1.5">
                  {(['active', 'inactive', 'blocked'] as const).map((s) => (
                    <button key={s} disabled={c.status === s} onClick={() => setStatus(c.id, s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-100 ${
                        c.status === s ? STATUS_STYLE[s]
                        : s === 'active' ? 'bg-green-50 text-green-700'
                        : s === 'inactive' ? 'bg-ink-100 text-ink-600'
                        : 'bg-red-50 text-red-600'
                      }`}>
                      {STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {c.auth_user_id && (
                    <button onClick={() => toggleAdmin(c)} disabled={busy}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${
                        adminIds.has(c.auth_user_id)
                          ? 'bg-ink-100 text-ink-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}>
                      {adminIds.has(c.auth_user_id) ? '★ 取消管理員' : '☆ 設為管理員'}
                    </button>
                  )}
                  <button onClick={() => (editId === c.id ? setEditId(null) : startEdit(c))}
                    className="px-3 py-1.5 rounded-lg bg-accent-50 text-accent-700 text-xs font-medium">
                    ✏️ 編輯
                  </button>
                  <button onClick={() => removeCustomer(c)} disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium disabled:opacity-50">
                    🗑 刪除
                  </button>
                </div>
              </div>

              {/* 編輯表單 */}
              {editId === c.id && (
                <div className="mt-3 space-y-2.5 border-t border-ink-100 pt-3">
                  <p className="text-xs font-bold text-ink-700">✏️ 編輯客戶資料</p>
                  <input placeholder="姓名" value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className={inputCls} />
                  <input placeholder="手機號碼（09XXXXXXXX）" inputMode="numeric" value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value.replace(/\D/g, '') })}
                    className={inputCls} />
                  {!editForm.hasAuth && (
                    <p className="text-[11px] text-amber-600">⚠ 此客戶未綁定登入帳號，僅會更新白名單資料</p>
                  )}
                  <select value={editForm.company_id}
                    onChange={(e) => setEditForm({ ...editForm, company_id: e.target.value, group_id: '' })}
                    className={inputCls}>
                    <option value="">選擇公司…</option>
                    {companies.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
                  </select>
                  <select value={editForm.group_id}
                    onChange={(e) => setEditForm({ ...editForm, group_id: e.target.value })}
                    className={inputCls}>
                    <option value="">選擇群組（選填）…</option>
                    {groups.filter((g) => !g.company_id || g.company_id === editForm.company_id)
                      .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <select value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value as Customer['status'] })}
                    className={inputCls}>
                    <option value="active">啟用</option>
                    <option value="inactive">停用</option>
                    <option value="blocked">封鎖</option>
                  </select>
                  {editForm.hasAuth && (
                    <input placeholder="新密碼（留空＝不變更）" value={editForm.newPassword}
                      onChange={(e) => setEditForm({ ...editForm, newPassword: e.target.value })}
                      className={inputCls} />
                  )}
                  {(editForm.phone !== editForm.originalPhone || editForm.newPassword !== '') && (
                    <p className="text-[11px] text-amber-600">⚠ 變更手機或密碼會同步更新該客戶的登入帳號</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button onClick={saveEdit} disabled={busy || !editValid}
                      className="flex-1 h-11 rounded-xl bg-ink-900 text-white text-sm font-semibold disabled:opacity-40">
                      {busy ? '儲存中…' : '儲存變更'}
                    </button>
                    <button onClick={() => setEditId(null)} disabled={busy}
                      className="h-11 px-4 rounded-xl bg-ink-100 text-ink-600 text-sm font-medium disabled:opacity-50">
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {customers.length === 0 && (
            <p className="text-center text-sm text-ink-400 py-8">尚無客戶</p>
          )}
        </section>
      </main>
  )
}
