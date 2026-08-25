import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Banner } from '../lib/types'

/** 首頁廣告看板輪播（企劃書：Banner Carousel） */
export default function BannerCarousel() {
  const [banners, setBanners] = useState<Banner[]>([])
  const [idx, setIdx] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    supabase
      .from('banners')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .then(({ data }) => {
        if (alive && data) setBanners(data as Banner[])
      })
    return () => { alive = false }
  }, [])

  const next = useCallback(() => {
    setIdx((i) => (banners.length ? (i + 1) % banners.length : 0))
  }, [banners.length])

  useEffect(() => {
    if (banners.length <= 1) return
    timerRef.current = setInterval(next, 5000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [banners.length, next])

  if (banners.length === 0) return null

  const b = banners[Math.min(idx, banners.length - 1)]
  const inner = (
    <div className="relative overflow-hidden rounded-2xl border border-ink-100 shadow-sm anim-fade-up">
      <img src={b.image_url} alt={b.title ?? 'banner'} className="w-full aspect-square object-cover" />
      {b.title && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent
                        px-4 pt-6 pb-3">
          <p className="text-base font-bold text-white truncate">{b.title}</p>
        </div>
      )}
      {/* 輪播圓點 */}
      {banners.length > 1 && (
        <div className="absolute top-2.5 right-3 flex gap-1.5">
          {banners.map((_, i) => (
            <span key={i} className={`h-2 rounded-full transition-colors duration-300 ${
              i === idx ? 'w-5 bg-white' : 'w-2 bg-white/60'
            }`} />
          ))}
        </div>
      )}
    </div>
  )

  return b.target_url ? (
    <a href={b.target_url} target="_blank" rel="noreferrer">{inner}</a>
  ) : (
    inner
  )
}

// 讓 Link import 不會因 tree-shake 被誤刪（保留未來站內跳轉用）
export const __BannerLink = Link
