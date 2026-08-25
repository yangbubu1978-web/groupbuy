import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import CampaignListPage from './pages/CampaignListPage'
import AdminLayout from './components/AdminLayout'

// 非首屏頁面採按需載入（route-based code-splitting：管理後台、明細、訂單等）
const ProductPage = lazy(() => import('./pages/ProductPage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const AdminProductsPage = lazy(() => import('./pages/AdminProductsPage'))
const AdminCustomersPage = lazy(() => import('./pages/AdminCustomersPage'))
const AdminOrdersPage = lazy(() => import('./pages/AdminOrdersPage'))
const AdminCompaniesPage = lazy(() => import('./pages/AdminCompaniesPage'))
const AdminBannersPage = lazy(() => import('./pages/AdminBannersPage'))
const AdminPromotionsPage = lazy(() => import('./pages/AdminPromotionsPage'))

function PageFallback() {
  return (
    <div className="min-h-dvh bg-ink-50 flex items-center justify-center">
      <p className="text-sm text-ink-400">載入中…</p>
    </div>
  )
}

/** 給 lazy 頁面的 Suspense 載入邊界 */
function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>
}

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
        <Route path="/product/:productId" element={<RequireAuth><LazyRoute><ProductPage /></LazyRoute></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><LazyRoute><OrdersPage /></LazyRoute></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><LazyRoute><ProfilePage /></LazyRoute></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminLayout /></RequireAuth>}>
          <Route index element={<LazyRoute><AdminPage /></LazyRoute>} />
          <Route path="products" element={<LazyRoute><AdminProductsPage /></LazyRoute>} />
          <Route path="companies" element={<LazyRoute><AdminCompaniesPage /></LazyRoute>} />
          <Route path="customers" element={<LazyRoute><AdminCustomersPage /></LazyRoute>} />
          <Route path="orders" element={<LazyRoute><AdminOrdersPage /></LazyRoute>} />
          <Route path="banners" element={<LazyRoute><AdminBannersPage /></LazyRoute>} />
          <Route path="promotions" element={<LazyRoute><AdminPromotionsPage /></LazyRoute>} />
        </Route>
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