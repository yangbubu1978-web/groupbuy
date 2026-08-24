import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import CampaignListPage from './pages/CampaignListPage'
import ProductPage from './pages/ProductPage'
import OrdersPage from './pages/OrdersPage'
import AdminPage from './pages/AdminPage'
import AdminProductsPage from './pages/AdminProductsPage'
import AdminCustomersPage from './pages/AdminCustomersPage'
import AdminOrdersPage from './pages/AdminOrdersPage'
import AdminCompaniesPage from './pages/AdminCompaniesPage'
import ProfilePage from './pages/ProfilePage'
import AdminBannersPage from './pages/AdminBannersPage'

/** 需要登入的頁面守衛（含首次登入強制改密碼） */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { userId, customer, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
        <p className="text-sm text-ink-400">載入中…</p>
      </div>
    )
  }
  if (!userId) return <Navigate to="/login" replace />
  // 企劃書規則：首登未改密碼 → 強制導向改密碼頁
  if (customer?.must_change_password) return <Navigate to="/change-password" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth><CampaignListPage /></RequireAuth>} />
        <Route path="/change-password" element={<ChangePasswordGate />} />
        <Route path="/product/:productId" element={<RequireAuth><ProductPage /></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/admin/products" element={<RequireAuth><AdminProductsPage /></RequireAuth>} />
        <Route path="/admin/companies" element={<RequireAuth><AdminCompaniesPage /></RequireAuth>} />
        <Route path="/admin/customers" element={<RequireAuth><AdminCustomersPage /></RequireAuth>} />
        <Route path="/admin/orders" element={<RequireAuth><AdminOrdersPage /></RequireAuth>} />
        <Route path="/admin/banners" element={<RequireAuth><AdminBannersPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}

/** 改密碼頁：已登入但尚未改密碼才能進；改完自動被 RequireAuth 放行 */
function ChangePasswordGate() {
  const { userId, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
        <p className="text-sm text-ink-400">載入中…</p>
      </div>
    )
  }
  if (!userId) return <Navigate to="/login" replace />
  return <ChangePasswordPage />
}
