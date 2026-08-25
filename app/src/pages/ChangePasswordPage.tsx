import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

/** 首次登入強制改密碼頁（企劃書：預設密碼 888888 首登必改） */
export default function ChangePasswordPage() {
  const { customer, refresh } = useAuth()
  const navigate = useNavigate()
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 6) {
      setError('新密碼至少需要 6 碼')
      return
    }
    if (newPassword !== confirm) {
      setError('兩次輸入的密碼不一致')
      return
    }
    setBusy(true)
    try {
      // 1. 更新 auth 密碼
      const { error: updErr } = await supabase.auth.updateUser({ password: newPassword })
      if (updErr) throw new Error('修改密碼失敗，請稍後再試')

      // 2. 清除旗標（security definer 函式；RLS 不開放直接 update）
      const { data: flagRes, error: flagErr } = await supabase
        .rpc('clear_must_change_password')
      const flag = (flagRes ?? {}) as { ok?: boolean; reason?: string }
      if (flagErr || !flag.ok) {
        throw new Error('密碼已更新，但狀態更新失敗，請重新登入一次')
      }
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失敗，請稍後再試')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh bg-ink-50 flex flex-col justify-center px-6 py-10">
      <div className="w-full max-w-sm mx-auto">
        <div className="text-center mb-8 anim-fade-up">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-600
                          flex items-center justify-center text-3xl shadow-lg shadow-accent-500/30">
            🔐
          </div>
          <h1 className="text-xl font-bold text-ink-900">請設定您的新密碼</h1>
          <p className="mt-2 text-sm text-ink-500">
            {customer?.name}，您好！<br />基於安全考量，首次登入需先更換預設密碼。
          </p>
        </div>

        <form onSubmit={submit} className="bg-white rounded-3xl border border-ink-100 p-6
                                           shadow-xl shadow-ink-900/5 space-y-4 anim-fade-up"
          style={{ animationDelay: '80ms' }}
        >
          <div>
            <label htmlFor="newpwd" className="block text-sm font-medium text-ink-700 mb-1.5">新密碼</label>
            <input id="newpwd" type="password" autoComplete="new-password" placeholder="至少 6 碼"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required
              className="w-full h-12 px-4 rounded-xl border border-ink-200 bg-white text-lg text-ink-900
                        placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400" />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-sm font-medium text-ink-700 mb-1.5">確認新密碼</label>
            <input id="confirm" type="password" autoComplete="new-password" placeholder="再輸入一次"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              className="w-full h-12 px-4 rounded-xl border border-ink-200 bg-white text-lg text-ink-900
                        placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400" />
          </div>

          {error && (
            <div role="alert" className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600 anim-pop-in">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white
                       text-base font-bold shadow-lg shadow-accent-500/25
                       active:scale-[0.98] transition disabled:opacity-50">
            {busy ? '設定中…' : '完成設定'}
          </button>
        </form>
      </div>
    </div>
  )
}
