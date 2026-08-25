// ============================================================
// 動態降價引擎（前端顯示用）v2
// ⚠️ 此計算僅供 UI 顯示；成交價一律以 Server 端
//    purchase_product() 交易瞬間的計算為準。
//
// 規則（2026-08 雅布大人拍板）：
//   1. 每 priceIntervalSeconds 秒降價一次
//   2. 每次降幅 = priceDecrease ～ priceDecreaseMax 之間的整數亂數
//      （priceDecreaseMax 未設定時＝固定降幅）
//   3. 單程到底：只在第一輪降價；到底後維持最低價（價格永不回彈，只降不漲），
//      停留一個降價週期未售罄即由 Server 自動下架
//   4. 「隨機」採確定性偽隨機（與 Server 同公式），所有人看到同一個價
//   5. 歸零計時：降價期間有人下單 → products.last_order_at = now()；
//      到底價後需「整整一輪」沒有任何人下單，Server 才會自動下架
//      （有人下單就把等候下架的倒數歸零重置）
//      ※ 價格仍錠定 sale_start_at（只降不漲）—— 歸零只影響「何時下架」，不影響價格曲線
//
// 時間軸語義：
//   第 k 個週期（k = floor(elapsed/interval)，k>=1）顯示「已套用 k 次降幅」的價格。
//   每一輪包含 k = 1…S，S = 保證到底價的最大步數；k>S 後一律停在最低價。
//   第 m 步的降幅 = randStep(productId|0|m)。
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

/** SHA-256（FIPS 180-4）決定論偽隨機 — 與 Server SQL `rand_step` 完全相同演算法
 *  Server: p_min + (前三十二位元 SHA-256 hex 當 unsigned bigint % (p_max-p_min+1))
 *  ⚠️ 此處 SHA-256 必須與 SQL `encode(sha256(convert_to(p_key,'UTF8')),'hex')`
 *     的前 8 個 hex 字元一致（見 migrations/20260822_b_random_pricing.sql）。 */
/** SHA-256 輪常數（FIPS 180-4） */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr32 = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0

/** 純 JS 同步 SHA-256 → 前 32 位元（unsigned bigint）
 *  輸入先做 UTF-8 編碼（與 SQL convert_to(p_key,'UTF8') 一致）
 *  取摘要前 4 bytes = 32 位元 bigint（與 SQL 前三十二位元一致） */
function sha256HashBits(str: string): number {
  // UTF-8 編碼 → bytes（與 SQL convert_to(p_key,'UTF8') 一致）
  const s = unescape(encodeURIComponent(str))
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i))
  const bitLenHi = Math.floor((s.length * 8) / 0x100000000)
  const bitLenLo = (s.length * 8) >>> 0

  // padding：0x80 + 0x00 補到 56 mod 64，最後 8 bytes = 原始訊息位元數（big-endian hi→lo）
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 3; i >= 0; i--) bytes.push((bitLenHi >>> (8 * i)) & 0xff)
  for (let i = 3; i >= 0; i--) bytes.push((bitLenLo >>> (8 * i)) & 0xff)

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19

  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array<number>(64)
    for (let i = 0; i < 16; i++) {
      w[i] = ((bytes[off + i * 4] * 256 + bytes[off + i * 4 + 1]) * 256 + bytes[off + i * 4 + 2]) * 256 + bytes[off + i * 4 + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }

  return h0 // 前 32 位元 = 摘要前 4 bytes 的 bigint（等價 SQL（'x'||left(hex,8))::bit(32)::bigint）
}

/** 決定論偽隨機整數 [min, max] — 與 Server SQL rand_step 完全一致 */
export function randStep(key: string, min: number, max: number): number {
  if (max <= min) return Math.round(min)
  const span = Math.max(1, max - min + 1)
  const bits = sha256HashBits(key)
  return min + (bits % span)
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
  // 單程到底：只在第一輪降價（round 固定 0）；到底後維持最低價，價格永不回彈
  const m = Math.max(1, Math.min(k, s))

  let dropped = 0
  for (let i = 0; i < m && dropped < range; i++) {
    dropped += randStep(`${productId}|0|${i}`, lo, hi)
  }
  return Math.max(min, original - dropped)
}

/** 距下一次降價的剩餘秒數（已到底價＝不再降，回傳 0） */
export function secondsToNextDrop(
  cfg: PricingConfig,
  elapsedSeconds: number,
): number {
  const original = cfg.originalPrice
  const min = Math.min(cfg.minimumPrice, original)
  const range = original - min
  const lo = Math.max(0, Math.round(cfg.priceDecrease))
  const hi = cfg.priceDecreaseMax != null
    ? Math.max(lo, Math.round(cfg.priceDecreaseMax))
    : lo
  const interval = Math.max(1, cfg.priceIntervalSeconds)
  const k = Math.floor(Math.max(0, elapsedSeconds) / interval)
  const s = Math.max(1, Math.ceil(range / Math.max(1, lo > 0 ? lo : hi)))
  if (hi <= 0 || range <= 0 || k >= s) return 0
  const into = Math.max(0, elapsedSeconds) % interval
  return Math.max(1, interval - into)
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
