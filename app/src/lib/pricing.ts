// ============================================================
// 動態降價引擎（前端顯示用）v2
// ⚠️ 此計算僅供 UI 顯示；成交價一律以 Server 端
//    purchase_product() 交易瞬間的計算為準。
//
// 規則（2026-08 雅布大人拍板；2026-09-15 新增「設定總降價時間」模式）：
//   1. 每 priceIntervalSeconds 秒降價一次
//   2. 舊模式（dropTotalSeconds 為 null）：每次降幅 = priceDecrease ～ priceDecreaseMax
//      之間的整數亂數（priceDecreaseMax 未設定時＝固定降幅）
//   3. 單程到底：只在第一輪降價；到底後維持最低價（價格永不回彈，只降不漲），
//      停留一個降價週期未售罄即由 Server 自動下架
//   4. 「隨機」採確定性偽隨機（與 Server 同公式），所有人看到同一個價
//   5. 歸零計時：降價期間有人下單 → products.last_order_at = now()；
//      到底價後需「整整一輪」沒有任何人下單，Server 才會自動下架
//      （有人下單就把等候下架的倒數歸零重置）
//      ※ 價格仍錠定 sale_start_at（只降不漲）—— 歸零只影響「何時下架」，不影響價格曲線
//   6. 新模式（dropTotalSeconds 非 null）：管理員只設定「起始價、底價、降價總時間、
//      降價間隔」，其餘由系統算（見下方 dropScheduleSummary 的文件）
//
// 時間軸語義：
//   第 k 個週期（k = floor(elapsed/interval)，k>=1）顯示「已套用 k 次降幅」的價格。
//   每一輪包含 k = 1…S，S = 保證到底價的最大步數；k>S 後一律停在最低價。
//   第 m 步的降幅 = randStep(productId|0|m)。
//
// ⚠️ Server 端 SQL 為唯一真相（migrations/20260822_b_random_pricing.sql ＋
//    migrations/20260922_drop_schedule_pricing.sql），
//    本檔公式必須與其完全一致；改任何一邊都要同步另一邊＋跑測試。
// ============================================================

export interface PricingConfig {
  originalPrice: number
  minimumPrice: number
  priceIntervalSeconds: number
  /** 每次降幅下限（元）— 僅舊隨機模式使用 */
  priceDecrease: number
  /** 每次降幅上限（元）；undefined/null＝固定降幅 — 僅舊隨機模式使用 */
  priceDecreaseMax?: number | null
  /** 降價總時間（秒）— 新模式；null/undefined＝舊隨機模式（既有商品完全不受影響） */
  dropTotalSeconds?: number | null
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

/* ══════════════════════════════════════════════════════════════
 * 新模式：設定總降價時間，系統自動計算降價價格
 * （雅布大人 2026-09-15 拍板；Server 端同公式見
 *   migrations/20260922_drop_schedule_pricing.sql）
 *
 * 管理員只決定「我要從多少錢、在多久之內降到多少錢」，其餘系統算：
 *   總降價金額 = 起始價格 − 最低價格（底價）
 *   變價次數 N = floor(降價總時間 ÷ 降價間隔)
 *                （除不盡時只走 N 次；實際總降價時間 = N × 間隔）
 *   每步降幅   = floor(總降價金額 ÷ N)   ← NT$ 一律整數元
 *   第 k 步價格 = max(底價, 起始價 − k × 每步降幅)；k ≥ N 之後固定為底價
 *   最後一步吸收餘數 → 最終價格精確等於底價、絕不低於底價
 *
 * 例：起始 399、底價 99、總時間 10 分鐘、間隔 1 分鐘
 *     → 總降價 300、變價 10 次、每步 30 → 399→369→…→129→99
 * ══════════════════════════════════════════════════════════════ */

export interface DropScheduleInput {
  /** 起始價格（元） */
  originalPrice: number
  /** 最低價格／底價（元） */
  minimumPrice: number
  /** 降價間隔（秒） */
  priceIntervalSeconds: number
  /** 降價總時間（秒） */
  dropTotalSeconds: number
}

export interface DropScheduleSummary {
  /** 起始價格（整數元，與 Server 同步取整） */
  originalPrice: number
  /** 底價（整數元） */
  minimumPrice: number
  /** 降價間隔（秒） */
  intervalSeconds: number
  /** 管理員設定的降價總時間（秒） */
  totalSeconds: number
  /** 變價次數 N */
  steps: number
  /** 每步降幅（元）— 最後一步可能更大 */
  stepAmount: number
  /** 最後一步實際降幅（吸收餘數後，元） */
  lastDropAmount: number
  /** 總降價金額（元） */
  totalDrop: number
  /** 實際總降價時間 = N × 間隔（秒） */
  effectiveTotalSeconds: number
  /** 降價總時間是否可被降價間隔整除 */
  timeExact: boolean
  /** 總降價金額是否可被變價次數整除 */
  amountExact: boolean
  /** 設定是否可用（errors 為空） */
  valid: boolean
  errors: string[]
}

export interface DropScheduleRow {
  /** 第幾次降價（0＝起始） */
  step: number
  /** 幾秒後（0, interval, 2×interval…） */
  atSeconds: number
  /** 該時刻的價格（元） */
  price: number
  /** 這一步降了多少錢（step 0 為 0） */
  dropAmount: number
}

export interface DropSchedule extends DropScheduleSummary {
  /** 完整價格時間表（step 0…N，共 N+1 列） */
  rows: DropScheduleRow[]
}

/** 單一數值 → 整數（與 Server SQL round() 對齊） */
const toInt = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** 變價次數上限（防呆）：超過就不給存，避免預覽／推播失控 */
export const MAX_DROP_STEPS = 1000

/**
 * 新模式參數試算（不產生時間表，可安心每秒呼叫）
 * ⚠️ 與 Server `compute_current_price`（20260922 版）逐行對齊
 */
export function dropScheduleSummary(input: DropScheduleInput): DropScheduleSummary {
  const originalPrice = toInt(input.originalPrice)
  const minimumPrice = Math.min(toInt(input.minimumPrice), originalPrice)
  const intervalSeconds = Math.max(1, toInt(input.priceIntervalSeconds))
  const totalSeconds = Math.max(0, toInt(input.dropTotalSeconds))
  const totalDrop = originalPrice - minimumPrice
  const steps = Math.floor(totalSeconds / intervalSeconds)

  const errors: string[] = []
  if (originalPrice <= 0) errors.push('起始價格必須大於 0')
  if (minimumPrice >= originalPrice) errors.push('最低價格（底價）必須小於起始價格')
  if (totalSeconds <= 0) errors.push('降價總時間必須大於 0')
  if (toInt(input.priceIntervalSeconds) < 1) errors.push('降價間隔至少要 1 秒')
  if (steps < 1) errors.push(`降價總時間必須至少等於一個降價間隔（${intervalSeconds} 秒），才會有降價次數`)

  const stepAmount = steps >= 1 && totalDrop > 0 ? Math.floor(totalDrop / steps) : 0
  if (steps >= 1 && totalDrop > 0 && stepAmount < 1) {
    errors.push('價差太小：每步降幅不足 $1，請減少變價次數或加大價差')
  }
  // 防呆：變價次數過多（例如 2 小時 ÷ 1 秒 = 7200 次）會讓預覽與降價通知難以運作
  if (steps > MAX_DROP_STEPS) {
    errors.push(`變價次數過多（${steps} 次，上限 ${MAX_DROP_STEPS} 次）：請加大降價間隔或縮短降價總時間`)
  }

  return {
    originalPrice,
    minimumPrice,
    intervalSeconds,
    totalSeconds,
    steps,
    stepAmount,
    lastDropAmount: steps >= 1 ? totalDrop - (steps - 1) * stepAmount : 0,
    totalDrop,
    effectiveTotalSeconds: steps * intervalSeconds,
    timeExact: totalSeconds % intervalSeconds === 0,
    amountExact: steps >= 1 && totalDrop % steps === 0,
    valid: errors.length === 0,
    errors,
  }
}

/** 新模式：完整價格時間表（後台預覽用；maxRows 防呆上限） */
export function planDropSchedule(input: DropScheduleInput, maxRows = 5000): DropSchedule {
  const s = dropScheduleSummary(input)
  const rows: DropScheduleRow[] = []
  if (s.totalDrop > 0 && s.steps >= 1) {
    const n = Math.min(s.steps, Math.max(0, maxRows))
    rows.push({ step: 0, atSeconds: 0, price: s.originalPrice, dropAmount: 0 })
    for (let k = 1; k <= n; k++) {
      const last = k >= s.steps
      rows.push({
        step: k,
        atSeconds: k * s.intervalSeconds,
        price: last ? s.minimumPrice : s.originalPrice - k * s.stepAmount,
        dropAmount: last ? s.lastDropAmount : s.stepAmount,
      })
    }
  }
  return { ...s, rows }
}

/**
 * 新模式價格曲線：
 *   k = floor(elapsed / interval)；k=0 → 起始價
 *   k ≥ N → 底價（最後一步吸收餘數，精確等於底價，絕不低於底價）
 * cfg.dropTotalSeconds 為 null 時回傳 null（＝請走舊隨機模式）
 */
export function computeScheduledPrice(cfg: PricingConfig, elapsedSeconds: number): number | null {
  if (cfg.dropTotalSeconds == null) return null
  const s = dropScheduleSummary({
    originalPrice: cfg.originalPrice,
    minimumPrice: cfg.minimumPrice,
    priceIntervalSeconds: cfg.priceIntervalSeconds,
    dropTotalSeconds: cfg.dropTotalSeconds,
  })
  if (s.totalDrop <= 0 || s.steps < 1) return s.originalPrice
  const k = Math.floor(Math.max(0, elapsedSeconds) / s.intervalSeconds)
  if (k >= s.steps) return s.minimumPrice
  return Math.max(s.minimumPrice, s.originalPrice - k * s.stepAmount)
}

/** 秒數 → 中文時長（600 →「10 分」；630 →「10 分 30 秒」；3900 →「1 小時 5 分」） */
export function formatDurationZh(totalSeconds: number): string {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (s === 0) return '0 秒'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} 小時`)
  if (m > 0) parts.push(`${m} 分`)
  if (r > 0) parts.push(`${r} 秒`)
  return parts.join(' ')
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
 *
 * 新模式（cfg.dropTotalSeconds 非 null）走 computeScheduledPrice，與舊模式完全分流。
 */
export function computeCurrentPrice(
  cfg: PricingConfig,
  elapsedSeconds: number,
  productId = '',
): number {
  if (cfg.dropTotalSeconds != null) {
    const scheduled = computeScheduledPrice(cfg, elapsedSeconds)
    if (scheduled != null) return scheduled
  }

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
  if (cfg.dropTotalSeconds != null) {
    const s = dropScheduleSummary({
      originalPrice: cfg.originalPrice,
      minimumPrice: cfg.minimumPrice,
      priceIntervalSeconds: cfg.priceIntervalSeconds,
      dropTotalSeconds: cfg.dropTotalSeconds,
    })
    if (s.totalDrop <= 0 || s.steps < 1) return 0
    const elapsed = Math.max(0, elapsedSeconds)
    if (Math.floor(elapsed / s.intervalSeconds) >= s.steps) return 0
    return Math.max(1, s.intervalSeconds - (elapsed % s.intervalSeconds))
  }

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
