// ============================================================
// 動態降價引擎（前端顯示用）v2
// ⚠️ 此計算僅供 UI 顯示；成交價一律以 Server 端
//    purchase_product() 交易瞬間的計算為準。
//
// 規則（2026-08 雅布大人拍板）：
//   1. 每 priceIntervalSeconds 秒降價一次
//   2. 每次降幅 = priceDecrease ～ priceDecreaseMax 之間的整數亂數
//      （priceDecreaseMax 未設定時＝固定降幅）
//   3. 到底價後該輪結束，下一個週期從原價重新開始降價
//   4. 「隨機」採確定性偽隨機（與 Server 同公式），所有人看到同一個價
//
// 時間軸語義：
//   第 k 個週期（k = floor(elapsed/interval)，k>=1）顯示「已套用 k 次降幅」的價格。
//   第 r 輪包含 k = r*S+1 … (r+1)*S，S = 一輪保證到底價的最大步數。
//   第 (r, m) 步的降幅 = randStep(productId|r|m)。
//
// ⚠️ Server 端 SQL 為唯一真相（migrations/20260822_b_random_pricing.sql），
//    本檔公式必須與其完全一致；改任何一邊都要同步另一邊＋跑測試。
// ============================================================

export interface PricingConfig {
  originalPrice: number
  minimumPrice: number
  priceIntervalSeconds: number
  /** 每次降幅下限（元） */
  priceDecrease: number
  /** 每次降幅上限（元）；undefined/null＝固定降幅 */
  priceDecreaseMax?: number | null
}

/** FNV-1a 32 位元雜湊 → [0,1) 決定論偽隨機（跨平台一致，不用 Math.random） */
function hashUnit(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    // FNV 質數乘法用位移模擬（避免超出 2^53）
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
    h >>>= 0 // 回到 32 位元無號數
  }
  return (h >>> 0) / 0x100000000
}

/** 確定性偽隨機整數 [min, max]（key 相同 → 結果相同） */
export function randStep(key: string, min: number, max: number): number {
  if (max <= min) return Math.round(min)
  return min + Math.floor(hashUnit(key) * (max - min + 1))
}

/**
 * 目前價格：
 *   k = floor(elapsed / interval)；k=0 → 原價
 *   S = 一輪保證到底價的步數 = ceil(range / max(1, lo||hi))
 *       （lo>0 用 lo：每步至少 lo 元，S 步內必然觸底；
 *         lo=0 用 hi 避免除零，此時不保證每輪觸底但迴圈有 v_acc<range 保護）
 *   round = (k-1)/S；m = k − round*S（本輪第 m 次）
 *   價格 = max(最低價, 原價 − Σ randStep(id|round|0..m-1))
 *   迴圈中途一旦累計 ≥ range 即停（等價於觸底）
 */
export function computeCurrentPrice(
  cfg: PricingConfig,
  elapsedSeconds: number,
  productId = '',
): number {
  const original = cfg.originalPrice
  const min = Math.min(cfg.minimumPrice, original)
  const range = original - min
  const lo = Math.max(0, Math.round(cfg.priceDecrease))
  const hi = cfg.priceDecreaseMax != null
    ? Math.max(lo, Math.round(cfg.priceDecreaseMax))
    : lo

  if (hi <= 0 || range <= 0) return original

  const interval = Math.max(1, cfg.priceIntervalSeconds)
  const k = Math.floor(Math.max(0, elapsedSeconds) / interval)
  if (k < 1) return original

  const s = Math.max(
    1,
    Math.ceil(range / Math.max(1, lo > 0 ? lo : hi)),
  )
  const round = Math.floor((k - 1) / s)
  const m = k - round * s

  let dropped = 0
  for (let i = 0; i < m && dropped < range; i++) {
    dropped += randStep(`${productId}|${round}|${i}`, lo, hi)
  }
  return Math.max(min, original - dropped)
}

/** 距下一次降價的剩餘秒數 */
export function secondsToNextDrop(
  cfg: PricingConfig,
  elapsedSeconds: number,
): number {
  const into = Math.max(0, elapsedSeconds) % Math.max(1, cfg.priceIntervalSeconds)
  return Math.max(1, cfg.priceIntervalSeconds - into)
}

/** 秒數 → 倒數字串（<1小時顯示 mm:ss；以上顯示 h:mm:ss） */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 降價間隔秒數 → 人性化中文（43200 →「12 小時」、90 →「90 秒」） */
export function formatInterval(seconds: number): string {
  const s = Math.max(1, Math.round(seconds))
  if (s % 3600 === 0) {
    const h = s / 3600
    return h === 1 ? '1 小時' : `${h} 小時`
  }
  if (s % 60 === 0) {
    const m = s / 60
    return m === 1 ? '1 分鐘' : `${m} 分鐘`
  }
  return `${s} 秒`
}
