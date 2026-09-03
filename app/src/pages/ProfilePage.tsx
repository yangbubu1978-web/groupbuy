import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Company, CustomerGroup, Product } from '../lib/types'
import { fmtMoney } from '../lib/types'
import { useLivePrice } from '../lib/useLivePrice'

const STATUS_LABEL: Record<string, string> = {
  active: '啟用中',
  inactive: '已停用',
  blocked: '已封鎖',
}

/** 我的關注清單項目（含即時價格＋單筆取消關注） */
function FollowItem({ product, onRemove, removing }: {
  product: Product; onRemove: (id: string) => void; removing: boolean
}) {
  const live = useLivePrice(product)
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <Link
        to={`/product/${product.id}`}
        className="flex items-center gap-3 flex-1 min-w-0 active:bg-ink-50 transition"
      >
        <div className="w-12 h-12 rounded-xl bg-ink-100 overflow-hidden shrink-0 flex items-center justify-center">
          {product.image_url ? (
            <img src={product.image_url} alt={product.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
          ) : (
            <span className="text-lg opacity-30">🎁</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-ink-900 truncate">{product.name}</p>
          <p className="text-sm text-ink-600">剩餘 {live.stock} 件</p>
        </div>
        <span className="text-base font-extrabold text-ink-900 tabular-nums shrink-0">
          {fmtMoney(live.price)}
        </span>
      </Link>
      <button
        onClick={() => onRemove(product.id)}
        disabled={removing}
        aria-label={`取消關注 ${product.name}`}
        className="w-11 h-11 shrink-0 rounded-full border border-ink-200 text-ink-500
                   hover:bg-red-50 hover:text-red-600 hover:border-red-200
                   disabled:opacity-40 transition flex items-center justify-center"
      >
        ✕
      </button>
    </div>
  )
}

export default function ProfilePage() {
  const { customer, userId, isAdmin, signOut, refresh } = useAuth()
  const navigate = useNavigate()

  // 管理員不需要會員個人頁：直接轉到管理後台
  useEffect(() => {
    if (isAdmin) navigate('/admin', { replace: true })
  }, [isAdmin, navigate])
  const [company, setCompany] = useState<Company | null>(null)
  const [group, setGroup] = useState<CustomerGroup | null>(null)
  const [followedProducts, setFollowedProducts] = useState<Product[]>([])
  // 補填手機狀態（方案 A）
  const [phoneInput, setPhoneInput] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null)
  const [emailInput, setEmailInput] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  void emailInput; void setEmailInput; void emailBusy; void setEmailBusy; void setEmailMsg
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [removingFollowId, setRemovingFollowId] = useState<string | null>(null)

  // 取消單筆關注（Realtime 訂閱會自動把清單同步）
  const removeFollow = async (productId: string) => {
    if (!userId) return
    setRemovingFollowId(productId)
    try {
      const { error } = await supabase
        .from('product_follows')
        .delete()
        .eq('user_id', userId)
        .eq('product_id', productId)
      if (error) throw error
      setFollowedProducts((prev) => prev.filter((x) => x.id !== productId))
    } catch {
      // 失敗不阻斷 UI；下次 Realtime 同步會修正
    } finally {
      setRemovingFollowId(null)
    }
  }

  useEffect(() => {
    ;(async () => {
      const { data: sess } = await supabase.auth.getSession()
      const em = sess.session?.user?.email ?? null
      setUserEmail(em && !em.includes('@phone.groupbuy.local') ? em : null)
      if (em) setEmailInput(em.includes('@phone.groupbuy.local') ? '' : em)
    })()
  }, [])

  useEffect(() => {
    if (!customer) return
    ;(async () => {
      if (customer.company_id) {
        const { data } = await supabase
          .from('companies')
          .select('*')
          .eq('id', customer.company_id)
          .maybeSingle()
        setCompany((data as Company) ?? null)
      }
      if (customer.group_id) {
        const { data } = await supabase
          .from('customer_groups')
          .select('*')
          .eq('id', customer.group_id)
          .maybeSingle()
        setGroup((data as CustomerGroup) ?? null)
      }
    })()
  }, [customer])

  // 載入我的關注商品（即時同步：取消關注自動從清單消失）
  useEffect(() => {
    if (!userId) return
    let alive = true

    const loadFollows = async () => {
      const { data } = await supabase
        .from('product_follows')
        .select('products(*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
      if (alive && data) {
        setFollowedProducts(
          data.map((r: { products: Product | Product[] | null }) =>
            Array.isArray(r.products) ? r.products[0] : r.products,
          ).filter((p): p is Product => !!p),
        )
      }
    }
    loadFollows()

    const channel = supabase
      .channel(`my-follows-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'product_follows', filter: `user_id=eq.${userId}` },
        () => { loadFollows() },
      )
      .subscribe()

    return () => {
      alive = false
      supabase.removeChannel(channel)
    }
  }, [userId])

  if (!customer) return null

  return (
    <div className="min-h-dvh bg-ink-50 pb-16">
      <header className="bg-white border-b border-ink-100 px-5 py-4 sticky top-0 z-10">
        <div className="max-w-md md:max-w-3xl mx-auto flex items-center justify-between">
          <Link to="/" className="w-11 h-11 -ml-1.5 rounded-full hover:bg-ink-100 text-ink-700 flex items-center justify-center" aria-label="返回">
            ←
          </Link>
          <h1 className="text-base font-bold text-ink-900 font-display">我的帳號</h1>
          <div className="w-9" />
        </div>
      </header>

      <main className="max-w-md md:max-w-3xl mx-auto px-4 pt-5 space-y-4">
        {/* 基本資料卡 */}
        <section className="bg-white rounded-2xl border border-ink-100 p-5 shadow-sm anim-fade-up">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-accent-400 to-accent-600
                            flex items-center justify-center text-xl font-bold text-white shadow-md
                            shadow-accent-500/30">
              {customer.name.slice(0, 1)}
            </div>
            <div>
              <h2 className="text-xl font-bold text-ink-900 font-display">{customer.name}</h2>
              <p className="text-base text-ink-500 tabular-nums">{customer.phone ?? '尚未填寫手機'}</p>
            </div>
          </div>

          <dl className="mt-5 space-y-3 text-base">
            <div className="flex justify-between">
              <dt className="text-ink-500">公司</dt>
              <dd className="text-ink-800 font-medium">{company?.name ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">客戶群組</dt>
              <dd className="text-ink-800 font-medium">{group?.name ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">帳號狀態</dt>
              <dd>
                <span className={`text-sm font-medium px-2.5 py-1 rounded-full ${
                  customer.status === 'active'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-600'
                }`}>
                  {STATUS_LABEL[customer.status] ?? customer.status}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-500">最後登入</dt>
              <dd className="text-ink-800 tabular-nums">
                {customer.last_login_at
                  ? new Date(customer.last_login_at).toLocaleString('zh-TW')
                  : '—'}
              </dd>
            </div>
          </dl>

          {/* E-MAIL 已移至「我的關注」 — 此處保留導流 */}
          <div className="mt-5 rounded-2xl border border-ink-100 bg-[#FFF8F0] p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-ink-800">💌 E-MAIL 通知信箱</p>
              <p className="text-xs text-ink-500 mt-1 break-all">{userEmail ? `目前：${userEmail}` : '尚未設定 — 至「我的關注」設定'}{emailMsg ? ` · ${emailMsg}` : ''}</p>
            </div>
            <a href="#/me/follows" className="h-9 px-4 rounded-full bg-[#FF8A65] text-white text-sm font-bold grid place-items-center shrink-0">去設定</a>
          </div>

          {/* 方案 A：手機後補 — 未填手機時顯示提醒與補填表單 */}
          {!customer.phone && (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <p className="text-base font-bold text-amber-800">📱 請補填手機號碼</p>
              <p className="text-sm text-amber-700 leading-relaxed">
                初次用姓名登入後，請在此補填手機號碼。<br />完成後，下次就能用「姓名」或「手機」兩種方式登入囉！
              </p>
              <div className="flex gap-2">
                <input
                  type="tel"
                  inputMode="numeric"
                  placeholder="09XXXXXXXX"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  className="flex-1 h-12 px-4 rounded-xl border border-amber-200 bg-white text-base text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-400"
                />
                <button
                  onClick={async () => {
                    setPhoneMsg(null)
                    const p = phoneInput.replace(/\D/g, '')
                    if (!/^09\d{8}$/.test(p)) { setPhoneMsg('❌ 手機格式應為 09 開頭 10 碼'); return }
                    setPhoneBusy(true)
                    try {
                      const { data, error } = await supabase.rpc('set_my_phone', { p_phone: p })
                      const res = (data ?? {}) as { ok?: boolean; reason?: string }
                      if (error || !res.ok) {
                        const reasonMap: Record<string, string> = {
                          invalid_phone: '手機格式不正確',
                          phone_exists: '此手機號碼已被其他帳號使用',
                          unauthenticated: '請重新登入',
                          not_found: '找不到帳號',
                        }
                        throw new Error(reasonMap[res.reason ?? ''] ?? '儲存失敗，請稍後再試')
                      }
                      setPhoneMsg('✅ 手機已儲存！下次可用姓名或手機登入')
                      setPhoneInput('')
                      await refresh()
                    } catch (e) {
                      setPhoneMsg(`❌ ${e instanceof Error ? e.message : '儲存失敗'}`)
                    } finally { setPhoneBusy(false) }
                  }}
                  disabled={phoneBusy || !/^09\d{8}$/.test(phoneInput.replace(/\D/g, ''))}
                  className="h-12 px-5 rounded-xl bg-ink-900 text-white text-base font-bold disabled:opacity-40 shrink-0"
                >
                  {phoneBusy ? '儲存中…' : '儲存'}
                </button>
              </div>
              {phoneMsg && <p className="text-sm text-center">{phoneMsg}</p>}
            </div>
          )}
        </section>

        {/* 我的關注 */}
        <section className="bg-white rounded-2xl border border-ink-100 shadow-sm anim-fade-up" style={{ animationDelay: '30ms' }}>
          <div className="flex items-center gap-3 px-5 py-4 border-b border-ink-100">
            <span className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">❤️</span>
            <span className="flex-1 font-medium text-base text-ink-700">我的關注</span>
            {followedProducts.length > 0 && (
              <span className="text-sm font-semibold text-accent-600">{followedProducts.length} 項</span>
            )}
          </div>
          {followedProducts.length > 0 ? (
            <div className="divide-y divide-ink-50">
              {followedProducts.map((p) => (
                <FollowItem key={p.id} product={p}
                  onRemove={removeFollow} removing={removingFollowId === p.id} />
              ))}
            </div>
          ) : (
            <p className="px-5 py-6 text-base text-ink-500 text-center">
              還沒有關注的商品～去商品頁按「🤍 關注」追蹤降價吧
            </p>
          )}
        </section>

        {/* 功能入口 */}
        <section className="bg-white rounded-2xl border border-ink-100 divide-y divide-ink-100 shadow-sm anim-fade-up" style={{ animationDelay: '60ms' }}>
          {isAdmin ? (
            /* 管理員：直接進管理後台（不需要會員的我的訂單） */
            <>
              <Link to="/admin" className="flex items-center gap-3 px-5 py-4 text-base text-ink-700">
                <span className="w-8 h-8 rounded-lg bg-accent-50 flex items-center justify-center">🛠️</span>
                <span className="flex-1 font-medium">管理後台</span>
                <span className="text-ink-300">→</span>
              </Link>
              <Link to="/admin/orders" className="flex items-center gap-3 px-5 py-4 text-base text-ink-700">
                <span className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">🧾</span>
                <span className="flex-1 font-medium">訂單管理</span>
                <span className="text-ink-300">→</span>
              </Link>
            </>
          ) : (
            <Link to="/orders" className="flex items-center gap-3 px-5 py-4 text-base text-ink-700">
              <span className="w-8 h-8 rounded-lg bg-ink-50 flex items-center justify-center">🧾</span>
              <span className="flex-1 font-medium">我的訂單</span>
              <span className="text-ink-300">→</span>
            </Link>
          )}
        </section>

        {/* 登出 */}
        <button
          onClick={signOut}
          className="w-full h-12 rounded-xl bg-white border border-ink-200 text-base font-bold text-red-600 active:scale-[0.99] transition"
        >
          登出
        </button>

        <p className="text-center text-sm text-ink-500 pt-2">
          🔒 封閉式私人團購平台 · 僅限受邀客戶
        </p>
      </main>
    </div>
  )
}
