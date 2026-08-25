import { useEffect } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export const ADMIN_NAV = [
  { to: '/admin', label: '後台總覽', icon: '📊', end: true },
  { to: '/admin/products', label: '商品管理', icon: '📦' },
  { to: '/admin/promotions', label: '促銷活動', icon: '🏷️' },
  { to: '/admin/customers', label: '客戶管理', icon: '👥' },
  { to: '/admin/companies', label: '合作公司', icon: '🏢' },
  { to: '/admin/orders', label: '訂單管理', icon: '🧾' },
  { to: '/admin/banners', label: '首頁看板', icon: '🖼️' },
]

/** PC 導向的後台共用版面：深色側欄（md 以上）＋內容區；手機改頂部＋橫向導覽 */
export default function AdminLayout() {
  const { isAdmin, loading, customer, signOut } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !isAdmin) navigate('/login', { replace: true })
  }, [loading, isAdmin, navigate])

  if (loading || !isAdmin) {
    return (
      <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
        <p className="text-sm text-ink-400">載入中…</p>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-ink-50 md:flex">
      {/* 深色側欄（桌機） */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col min-h-[100dvh] bg-ink-900 text-white sticky top-0 h-[100dvh]">
        <div className="px-6 py-5 border-b border-white/10">
          <div className="text-sm font-bold tracking-wide">特價倒數平台</div>
          <div className="text-[11px] text-white/45 mt-0.5">管理後台</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {ADMIN_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  isActive ? 'bg-white/15 text-white' : 'text-white/65 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <span className="text-base leading-none">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-white/10 space-y-1">
          <Link
            to="/"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-white/70 hover:bg-white/5 hover:text-white transition"
          >
            <span className="text-base leading-none">🏠</span>
            回前台
          </Link>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium bg-red-600/15 text-red-300 hover:bg-red-600/30 transition"
          >
            <span className="text-base leading-none">⎋</span>
            登出（{customer?.name ?? '管理員'}）
          </button>
        </div>
      </aside>

      {/* 主內容 */}
      <div className="flex-1 min-w-0">
        {/* 手機頂部列 */}
        <header className="md:hidden sticky top-0 z-20 bg-ink-900 text-white px-4 py-3 flex items-center justify-between">
          <span className="text-sm font-bold">特價倒數平台</span>
          <button onClick={signOut} className="text-xs font-medium text-red-300">
            登出（{customer?.name ?? '管理員'}）
          </button>
        </header>
        {/* 手機橫向導覽 */}
        <nav className="md:hidden sticky top-[48px] z-20 bg-ink-900 text-white px-3 py-2 flex gap-1.5 overflow-x-auto">
          {ADMIN_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  isActive ? 'bg-white text-ink-900' : 'bg-white/10 text-white/80'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="px-4 py-5 md:px-8 md:py-8">
          <div className="max-w-5xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}