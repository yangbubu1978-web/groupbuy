import { Link } from 'react-router-dom'

const MODULES = [
  { to: '/admin/products', icon: '📦', title: '商品管理', desc: '設定販售商品、開賣時間與草稿', tint: 'bg-accent-50', ring: 'hover:border-accent-200' },
  { to: '/admin/promotions', icon: '🏷️', title: '促銷活動', desc: '限時促銷與草稿發布', tint: 'bg-orange-50', ring: 'hover:border-orange-200' },
  { to: '/admin/customers', icon: '👥', title: '客戶管理', desc: '帳號、群組與權限', tint: 'bg-blue-50', ring: 'hover:border-blue-200' },
  { to: '/admin/companies', icon: '🏢', title: '合作公司', desc: '合作企業名單', tint: 'bg-violet-50', ring: 'hover:border-violet-200' },
  { to: '/admin/orders', icon: '🧾', title: '訂單管理', desc: '查看與匯出成交紀錄', tint: 'bg-green-50', ring: 'hover:border-green-200' },
  { to: '/admin/banners', icon: '🖼️', title: '首頁看板', desc: '廣告輪播圖片', tint: 'bg-pink-50', ring: 'hover:border-pink-200' },
]

/** 後台總覽（實驗對照參考站「特價倒數平台」的 dashboard 卡片網格） */
export default function AdminPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-bold text-ink-900">後台總覽</h1>
        <p className="text-sm text-ink-400 mt-1">快速前往各管理模組</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {MODULES.map((m) => (
          <Link
            key={m.to}
            to={m.to}
            className={`group bg-white rounded-2xl border border-ink-100 p-5 shadow-sm hover:shadow-md transition ${m.ring}`}
          >
            <span className={`inline-flex w-11 h-11 rounded-xl items-center justify-center text-xl md:text-2xl ${m.tint}`}>
              {m.icon}
            </span>
            <div className="mt-3 text-sm md:text-base font-bold text-ink-900">{m.title}</div>
            <div className="mt-0.5 text-xs md:text-sm text-ink-400">{m.desc}</div>
            <div className="mt-3 text-xs md:text-sm font-semibold text-accent-600 group-hover:translate-x-1 transition">
              前往設定 →
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}