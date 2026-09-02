import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFollow, isValidUUID } from '../lib/useFollow'

export interface FollowButtonProps {
  productId: string
  saleStartAt: string | null
  size?: 'card' | 'detail'
  className?: string
  /** 庫存數量；若提供且 <=0 視為已售罄 */
  stock?: number
}

export default function FollowButton({
  productId,
  saleStartAt,
  size = 'card',
  className = '',
  stock,
}: FollowButtonProps) {
  const navigate = useNavigate()
  const { followed, notifyPriceDrop, loading, toggling, toggleFollow, setNotifyPriceDrop } = useFollow(productId)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgKind, setMsgKind] = useState<'ok' | 'error'>('ok')

  // 自動清除提示（3 秒）
  useEffect(() => {
    if (!msg) return
    const id = setTimeout(() => setMsg(null), 3000)
    return () => clearTimeout(id)
  }, [msg])

  const invalidId = !isValidUUID(productId)
  const isOnSale = (() => {
    if (!saleStartAt) return false
    const t = new Date(saleStartAt).getTime()
    if (Number.isNaN(t)) return false
    return t <= Date.now()
  })()
  const soldOut = typeof stock === 'number' && stock <= 0
  const disabledByState = isOnSale || soldOut || invalidId

  const handleClick = async () => {
    if (disabledByState) return
    const res = await toggleFollow()
    if (!res.ok) {
      if (res.reason === 'not_logged_in' || res.reason === 'unauthorized') {
        setMsgKind('error')
        setMsg('請先登入才能關注')
        navigate('/login')
        return
      }
      if (res.reason === 'invalid_product_id') {
        setMsgKind('error')
        setMsg('商品資訊異常')
        return
      }
      if (res.reason === 'busy') return
      setMsgKind('error')
      setMsg('操作失敗，請稍後再試')
      return
    }
    setMsgKind('ok')
    setMsg(followed ? '已取消關注' : '已關注，上架時通知你')
  }

  // 已上架 / 已售罄時的文字
  let disabledLabel: string | null = null
  if (soldOut) disabledLabel = '已售罄'
  else if (isOnSale) disabledLabel = '已開賣'
  else if (invalidId) disabledLabel = '—'

  const isDetail = size === 'detail'

  // 尺寸與樣式
  const base =
    'inline-flex items-center justify-center gap-1.5 font-bold rounded-xl border-2 ' +
    'transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
    (isDetail ? 'h-12 px-6 text-base min-w-[140px]' : 'h-10 px-4 text-sm min-w-[112px]')

  let variant = ''
  if (disabledByState) {
    variant =
      'bg-ink-100 border-ink-200 text-ink-400 focus-visible:ring-ink-300'
  } else if (followed) {
    // 已關注：深色樣式（不只靠顏色，icon + 文字雙重區分）
    variant =
      'bg-ink-800 border-ink-800 text-white hover:bg-ink-900 focus-visible:ring-ink-600'
  } else {
    // 未關注：亮橘樣式
    variant =
      'bg-accent-500 border-accent-500 text-white hover:bg-accent-600 focus-visible:ring-accent-400 shadow-sm'
  }

  const label = disabledByState
    ? disabledLabel
    : followed
      ? '🔕 已關注'
      : '🔔 關注上架'

  const ariaLabel = disabledByState
    ? disabledLabel ?? undefined
    : followed
      ? '取消商品上架通知'
      : '關注商品上架通知'

  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabledByState || loading || toggling}
        aria-label={ariaLabel}
        aria-pressed={followed}
        aria-busy={toggling || loading}
        className={`${base} ${variant}`}
      >
        {toggling ? (
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true" />
        ) : null}
        <span>{loading && !toggling ? '⋯' : label}</span>
      </button>
      {msg && (
        <span
          role="status"
          aria-live="polite"
          className={`text-sm font-medium px-1 ${msgKind === 'error' ? 'text-red-600' : 'text-green-700'}`}
        >
          {msg}
        </span>
      )}
      {followed && !disabledByState && (
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-600 cursor-pointer select-none mt-1">
          <input type="checkbox" checked={notifyPriceDrop} onChange={e => setNotifyPriceDrop(e.target.checked)} className="w-3.5 h-3.5 rounded border-ink-300 accent-ink-900" />
          也通知降價 30%
        </label>
      )}
    </span>
  )
}
