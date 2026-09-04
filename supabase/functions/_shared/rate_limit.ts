// ============================================================
// 共用：簡易記憶體限流（Edge Function 單實例計數，冷啟歸零可接受）
// 以 JWT 內的 user_id（有登入）或 IP 為鍵，滑動窗口內超過次數回 429。
// 用途：purchase / reserve / checkout 等交易入口防腳本高頻。
// 節點水平擴展時各實例獨立計數（最壞情況＝限流上限 × 節點數），可接受。
// ============================================================

interface Bucket {
  timestamps: number[]
}

const buckets = new Map<string, Bucket>()

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
  remaining: number
}

/**
 * 檢查此鍵在 windowSeconds 秒內是否還有額度。
 * 例：rateLimit(`u:${userId}`, 10, 60) = 每分鐘最多 10 次。
 */
export function rateLimit(key: string, maxRequests: number, windowSeconds: number): RateLimitResult {
  const now = Date.now()
  const windowMs = windowSeconds * 1000
  const bucket = buckets.get(key) ?? { timestamps: [] }

  // 清掉窗口外的紀錄
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)

  if (bucket.timestamps.length >= maxRequests) {
    // 最早一次仍在窗口內 → 這次拒絕，算出還要等多久
    const oldest = bucket.timestamps[0]
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    buckets.set(key, bucket)
    return { allowed: false, retryAfterSeconds, remaining: 0 }
  }

  bucket.timestamps.push(now)
  buckets.set(key, bucket)

  // 簡易清理：桶數過多時掃一次，避免長尾記憶體成長
  if (buckets.size > 10_000) {
    const cutoff = now - windowMs
    for (const [k, b] of buckets) {
      const live = b.timestamps.filter((t) => t > cutoff)
      if (live.length === 0) buckets.delete(k)
      else b.timestamps = live
    }
  }

  return { allowed: true, retryAfterSeconds: 0, remaining: maxRequests - bucket.timestamps.length }
}

/** 從請求解析限流鍵：優先使用者（x- 或 Authorization JWT 由呼叫端先驗證後傳 uid），否則 IP。 */
export function rateLimitKeyFrom(userId: string | null, req: Request): string {
  if (userId) return `u:${userId}`
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  return `ip:${ip}`
}
