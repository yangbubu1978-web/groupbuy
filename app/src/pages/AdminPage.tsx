import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function AdminPage() {
  const { isAdmin, loading: authLoading, customer, signOut } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && !isAdmin) navigate('/login', { replace: true })
  }, [authLoading, isAdmin, navigate])

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white border-b border-ink-100 px-5 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <Link to="/" className="w-9 h-9 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-600" aria-label="返回">
            ←
          </Link>
          <h1 className="text-base font-bold text-ink-900 font-display">管理後台</h1>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-6">
        {/* 快速入口 */}
        <section className="grid grid-cols-2 gap-2.5">
          <Link to="/admin/banners" className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm
                                                 flex items-center gap-3 active:scale-[0.98] transition
                                                 hover:border-pink-200">
            <span className="w-10 h-10 rounded-xl bg-pink-50 flex items-center justify-center text-lg">🖼️</span>
            <div>
              <div className="text-sm font-bold text-ink-900">首頁看板</div>
              <div className="text-[11px] text-ink-400">廣告輪播</div>
            </div>
          </Link>
          <Link to="/admin/customers" className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm
                                                 flex items-center gap-3 active:scale-[0.98] transition
                                                 hover:border-blue-200">
            <span className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-lg">👥</span>
            <div>
              <div className="text-sm font-bold text-ink-900">客戶</div>
              <div className="text-[11px] text-ink-400">帳號與權限</div>
            </div>
          </Link>
          <Link to="/admin/companies" className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm
                                                 flex items-center gap-3 active:scale-[0.98] transition
                                                 hover:border-violet-200">
            <span className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center text-lg">🏢</span>
            <div>
              <div className="text-sm font-bold text-ink-900">公司</div>
              <div className="text-[11px] text-ink-400">合作企業</div>
            </div>
          </Link>
          <Link to="/admin/products" className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm
                                                 flex items-center gap-3 active:scale-[0.98] transition
                                                 hover:border-accent-200">
            <span className="w-10 h-10 rounded-xl bg-accent-50 flex items-center justify-center text-lg">📦</span>
            <div>
              <div className="text-sm font-bold text-ink-900">商品</div>
              <div className="text-[11px] text-ink-400">價格與庫存</div>
            </div>
          </Link>
          <Link to="/admin/orders" className="bg-white rounded-2xl border border-ink-100 p-4 shadow-sm
                                                 flex items-center gap-3 active:scale-[0.98] transition
                                                 hover:border-green-200">
            <span className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center text-lg">🧾</span>
            <div>
              <div className="text-sm font-bold text-ink-900">訂單</div>
              <div className="text-[11px] text-ink-400">成交紀錄</div>
            </div>
          </Link>
        </section>

        {/* 登出（管理員不經個人頁，後台直接提供） */}
        <button
          onClick={signOut}
          className="w-full h-12 rounded-xl bg-white border border-ink-200 text-sm font-medium text-red-600 active:scale-[0.99] transition"
        >
          登出（{customer?.name ?? '管理員'}）
        </button>
      </main>
    </div>
  )
}
