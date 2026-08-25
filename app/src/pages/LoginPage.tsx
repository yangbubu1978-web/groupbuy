import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const REASON_TEXT: Record<string, string> = {
  invalid_phone: '格式不正確（姓名／09 開頭手機／管理帳號）',
  name_not_found: '找不到這個姓名，請確認白名單或改用手機登入',
  phone_not_found: '找不到這個手機號碼，請確認是否已補填手機或改用姓名登入',
  bad_credentials: '帳號或密碼不正確',
  not_whitelisted: '此帳號尚未開通，請聯絡管理員',
  account_inactive: '帳號已停用，請聯絡管理員',
  account_blocked: '帳號已被封鎖，請聯絡管理員',
}

export default function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const r = await signIn(phone, password)
    setBusy(false)
    if (r.ok) {
      navigate('/', { replace: true })
    } else {
      setError(REASON_TEXT[r.reason ?? ''] ?? '登入失敗，請稍後再試')
    }
  }

  return (
    <div className="min-h-dvh bg-ink-50 flex flex-col justify-center px-6 py-10">
      <div className="w-full max-w-sm mx-auto">
        {/* 品牌區 */}
        <div className="text-center mb-8 anim-fade-up">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-accent-400 to-accent-600
                          flex items-center justify-center text-3xl shadow-lg shadow-accent-500/30
                          rotate-3 hover:rotate-0 transition-transform duration-300">
            ⏱️
          </div>
          <h1 className="text-2xl font-extrabold text-ink-900 leading-tight">吸引力生活好物</h1>
          <p className="mt-1.5 text-base font-bold text-accent-500 tracking-wide">先買先贏</p>
          <p className="mt-2 text-sm text-ink-500">僅限受邀客戶登入使用</p>
          <div className="mt-3 inline-flex items-center gap-1 rounded-full bg-accent-50 border border-accent-200
                          px-3 py-1 text-xs font-semibold text-accent-600" aria-hidden="true">
            ⚡ 限時降價 × 庫存有限
          </div>
        </div>

        {/* 登入表單卡片 */}
        <form onSubmit={submit} className="bg-white rounded-3xl border border-ink-100 p-6
                                           shadow-xl shadow-ink-900/5 space-y-4 anim-fade-up"
          style={{ animationDelay: '80ms' }}
        >
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-ink-700 mb-1.5">
              姓名 / 手機 / 帳號
            </label>
            <input
              id="phone"
              type="text"
              autoComplete="username"
              placeholder="姓名（例：楊黃弦）或 09 手機"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              className="w-full h-12 px-4 rounded-xl border border-ink-200 bg-white
                         text-lg text-ink-900 placeholder:text-ink-400
                         focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink-700 mb-1.5">
              密碼
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="請輸入密碼"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full h-12 px-4 rounded-xl border border-ink-200 bg-white
                         text-lg text-ink-900 placeholder:text-ink-400
                         focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600 anim-pop-in">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white
                       text-base font-bold shadow-lg shadow-accent-500/25
                       active:scale-[0.98] transition disabled:opacity-50"
          >
            {busy ? '登入中…' : '登入'}
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-ink-500 leading-relaxed anim-fade-up" style={{ animationDelay: '160ms' }}>
          本平台為封閉式系統，不提供註冊。<br />
          帳號由管理員統一建立。
        </p>
      </div>
    </div>
  )
}
