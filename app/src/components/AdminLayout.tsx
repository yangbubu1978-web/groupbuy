import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export const ADMIN_NAV = [
  { to: '/admin', label: '後台總覽', icon: '📊', end: true },
  { to: '/admin/banners', label: '首頁看板', icon: '🖼️' },
  { to: '/admin/products', label: '商品管理', icon: '📦' },
  { to: '/admin/promotions', label: '促銷活動', icon: '🏷️' },
  { to: '/admin/orders', label: '訂單管理', icon: '🧾' },
  { to: '/admin/customers', label: '客戶管理', icon: '👥' },
  { to: '/admin/companies', label: '合作公司', icon: '🏢' },
]

/** PC 導向的後台共用版面：亮橘側欄（md 以上）＋內容區；手機改頂部＋橫向導覽 */
export default function AdminLayout() {
  const { isAdmin, loading, customer, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const handleNavReset = (to: string) => {
    window.dispatchEvent(new CustomEvent('admin-nav-reset', { detail: to }))
    if (location.pathname === to || location.pathname.startsWith(to + '?') || location.search) {
      navigate(to, { replace: true })
    }
    window.scrollTo({ top: 0 })
  }

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
      {/* 亮橘側欄（桌機） */}
      <aside className="hidden md:flex w-72 shrink-0 flex-col min-h-[100dvh] bg-accent-500 text-white sticky top-0 h-[100dvh]">
        <Link to="/" className="block px-6 py-5 border-b border-white/15 hover:bg-white/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60" aria-label="回到前台首頁">
          <div className="text-base md:text-lg font-bold tracking-wide">特價倒數平台</div>
          <div className="text-xs md:text-sm text-white/70 mt-1">管理後台 · 點此回前台</div>
        </Link>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {ADMIN_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => handleNavReset(n.to)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] md:text-base font-medium transition ${
                  isActive ? 'bg-white/25 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <span className="text-lg md:text-xl leading-none">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-white/15 space-y-1">
          <Link
            to="/"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] md:text-base text-white/80 hover:bg-white/10 hover:text-white transition"
          >
            <span className="text-lg md:text-xl leading-none">🏠</span>
            回前台
          </Link>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] md:text-base font-medium bg-red-600/20 text-red-100 hover:bg-red-600/35 transition"
          >
            <span className="text-lg md:text-xl leading-none">⎋</span>
            登出（{customer?.name ?? '管理員'}）
          </button>
        </div>
      </aside>

      {/* 主內容 */}
      <div className="flex-1 min-w-0">
        {/* 手機頂部列 */}
        <header className="md:hidden sticky top-0 z-20 bg-accent-500 text-white px-4 py-3 flex items-center justify-between">
          <Link to="/" className="text-sm font-bold hover:opacity-90 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded" aria-label="回到前台首頁">特價倒數平台 🏠</Link>
          <div className="flex items-center gap-3">
            <Link to="/" className="text-xs font-bold px-2.5 py-1 rounded-full bg-white/20 hover:bg-white/30 transition">回前台</Link>
            <button onClick={signOut} className="text-xs font-medium text-red-200">
              登出（{customer?.name ?? '管理員'}）
            </button>
          </div>
        </header>
        {/* 手機橫向導覽 */}
        <nav className="md:hidden sticky top-[48px] z-20 bg-accent-500 text-white px-3 py-2 flex gap-1.5 overflow-x-auto">
          {ADMIN_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => handleNavReset(n.to)}
              className={({ isActive }) =>
                `shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  isActive ? 'bg-white text-ink-900' : 'bg-white/15 text-white/90'
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