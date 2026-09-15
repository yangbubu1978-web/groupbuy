import { describe, it, expect } from 'vitest'
import {
  computeCurrentPrice,
  secondsToNextDrop,
  formatCountdown,
  formatInterval,
  randStep,
  dropScheduleSummary,
  planDropSchedule,
  computeScheduledPrice,
  formatDurationZh,
} from './pricing'

// 固定降幅（相容舊設定）：原 1500 底 1000 每 60 秒降 10
const fixed = {
  originalPrice: 1500,
  minimumPrice: 1000,
  priceIntervalSeconds: 60,
  priceDecrease: 10,
}

describe('computeCurrentPrice：固定降幅（相容模式）', () => {
  it('0 秒與未滿一個週期：原價', () => {
    expect(computeCurrentPrice(fixed, 0, 'p1')).toBe(1500)
    expect(computeCurrentPrice(fixed, 59, 'p1')).toBe(1500)
  })

  it('60 秒整：降一次 $1,490', () => {
    expect(computeCurrentPrice(fixed, 60, 'p1')).toBe(1490)
  })

  it('600 秒：10 步 → $1,400', () => {
    expect(computeCurrentPrice(fixed, 600, 'p1')).toBe(1400)
  })

  it('到底價：第 49 步 $1,010、第 50 步觸底 $1,000', () => {
    expect(computeCurrentPrice(fixed, 49 * 60, 'p1')).toBe(1010)
    expect(computeCurrentPrice(fixed, 50 * 60, 'p1')).toBe(1000)
    expect(computeCurrentPrice(fixed, 50 * 60 + 59, 'p1')).toBe(1000) // 觸底維持一個週期
  })

  it('單程到底：到底後維持最低價，價格永不回彈', () => {
    // S=50 → 第 51 個週期起（過去曾是新一輪）仍停在最低價
    expect(computeCurrentPrice(fixed, 51 * 60, 'p1')).toBe(1000)
    expect(computeCurrentPrice(fixed, 100 * 60, 'p1')).toBe(1000)
    expect(computeCurrentPrice(fixed, 101 * 60, 'p1')).toBe(1000)
    expect(computeCurrentPrice(fixed, 5000 * 60, 'p1')).toBe(1000)
  })

  it('無限跑下去也不會低於最低價', () => {
    for (let t = 0; t < 500; t += 37) {
      expect(computeCurrentPrice(fixed, t * 60 * 3, 'p1')).toBeGreaterThanOrEqual(1000)
    }
  })
})

describe('computeCurrentPrice：隨機區間（1~20 元）', () => {
  const rnd = {
    originalPrice: 600,
    minimumPrice: 100,
    priceIntervalSeconds: 43200, // 12 小時
    priceDecrease: 1,
    priceDecreaseMax: 20,
  }

  it('未滿 12 小時：原價', () => {
    expect(computeCurrentPrice(rnd, 43199, 'x')).toBe(600)
  })

  it('12 小時整：降一次，介於 580～599', () => {
    const p = computeCurrentPrice(rnd, 43200, 'x')
    expect(p).toBeGreaterThanOrEqual(580)
    expect(p).toBeLessThanOrEqual(599)
  })

  it('同一 key 結果可重現（Server 同公式）', () => {
    expect(computeCurrentPrice(rnd, 86400 * 3, 'x'))
      .toBe(computeCurrentPrice(rnd, 86400 * 3, 'x'))
  })

  it('永遠不會低於最低價、不會高於原價', () => {
    for (let h = 0; h < 24 * 90; h++) {
      const p = computeCurrentPrice(rnd, h * 3600, 'y')
      expect(p).toBeGreaterThanOrEqual(100)
      expect(p).toBeLessThanOrEqual(600)
    }
  })

  it('randStep 邊界：min=max 時回傳定值', () => {
    expect(randStep('k', 5, 5)).toBe(5)
  })

  it('randStep 值域落在 [min,max]', () => {
    for (let i = 0; i < 200; i++) {
      const v = randStep(`key-${i}`, 1, 20)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(20)
    }
  })
})

describe('回歸測試：前台顯示價必須與 Server SQL rand_step（SHA-256）一致', () => {
  // 2026-08-25 真實案例：紐西蘭 8+Minute 魚子醬洗髮精
  // 前台 FNV-1a 曾算出 $116，但 Server SHA-256 成交 $122 → 顯示價≠成交價 bug
  // 此測試鎖定與 SQL encode(sha256(convert_to(key,'UTF8')),'hex') 前 8 hex 相同的值
  const pid = '22676faa-71ac-4dbc-b2dd-1ae14e3d8f45'
  const cfg = {
    originalPrice: 150,
    minimumPrice: 50,
    priceIntervalSeconds: 600,
    priceDecrease: 10,
    priceDecreaseMax: 20,
  }

  it('randStep 各步降幅與 Server SQL 完全一致', () => {
    // 由 Server compute_current_price 實測回推（k=2 → $122）
    expect(randStep(`${pid}|0|0`, 10, 20)).toBe(18)
    expect(randStep(`${pid}|0|1`, 10, 20)).toBe(10)
  })

  it('k=2 顯示價 = 成交價 $122（不再跑出 $116）', () => {
    expect(computeCurrentPrice(cfg, 2 * 600, pid)).toBe(122)
  })

  it('k=1、k=3 也與 Server 一致', () => {
    expect(computeCurrentPrice(cfg, 1 * 600, pid)).toBe(132)
    expect(computeCurrentPrice(cfg, 3 * 600, pid)).toBe(108)
  })
})

// ══════════════════════════════════════════════════════════════
// 新模式：設定總降價時間，自動計算降價價格（2026-09-15 雅布大人拍板）
// 這些期望值同時由本機 PostgreSQL 實跑 compute_current_price 驗證過
// （supabase/drop-schedule-migration-test.sql），即前後端同公式的回歸鎖。
// ══════════════════════════════════════════════════════════════
const sched = (originalPrice: number, minimumPrice: number, totalSeconds: number, interval: number) => ({
  originalPrice, minimumPrice, priceIntervalSeconds: interval, priceDecrease: 0, priceDecreaseMax: null,
  dropTotalSeconds: totalSeconds,
})

describe('computeCurrentPrice：新模式（設定總降價時間）', () => {
  it('雅布大人原始情境：399→99、10 分鐘、每 1 分鐘 → 每步 30', () => {
    const cfg = sched(399, 99, 600, 60)
    const seq = Array.from({ length: 11 }, (_, k) => computeCurrentPrice(cfg, k * 60 + 20))
    expect(seq).toEqual([399, 369, 339, 309, 279, 249, 219, 189, 159, 129, 99])
    expect(dropScheduleSummary({ originalPrice: 399, minimumPrice: 99, priceIntervalSeconds: 60, dropTotalSeconds: 600 }))
      .toMatchObject({ steps: 10, stepAmount: 30, lastDropAmount: 30, totalDrop: 300, timeExact: true, amountExact: true, valid: true })
  })

  it('未滿一期＝起始價；到底價後永不低於底價、不再繼續降', () => {
    const cfg = sched(399, 99, 600, 60)
    expect(computeCurrentPrice(cfg, 0)).toBe(399)
    expect(computeCurrentPrice(cfg, 59.9)).toBe(399)
    expect(computeCurrentPrice(cfg, 600)).toBe(99)
    expect(computeCurrentPrice(cfg, 660)).toBe(99)
    expect(computeCurrentPrice(cfg, 60000)).toBe(99)
  })

  it('無法整除：999→299、30 分鐘、每 1 分鐘 → N=30、每步 23、最後一步 33', () => {
    const cfg = sched(999, 299, 1800, 60)
    const s = dropScheduleSummary({ originalPrice: 999, minimumPrice: 299, priceIntervalSeconds: 60, dropTotalSeconds: 1800 })
    expect(s).toMatchObject({ steps: 30, stepAmount: 23, lastDropAmount: 33, totalDrop: 700, amountExact: false, valid: true })
    expect(computeCurrentPrice(cfg, 1 * 60 + 20)).toBe(976)
    expect(computeCurrentPrice(cfg, 29 * 60 + 20)).toBe(332)
    expect(computeCurrentPrice(cfg, 30 * 60 + 20)).toBe(299)   // 最後一步吸收餘數，精確到底價
    expect(computeCurrentPrice(cfg, 31 * 60 + 20)).toBe(299)
  })

  it('降價間隔 10 秒／30 秒／1 分鐘／5 分鐘：同樣 10 分鐘到底，節奏不同', () => {
    const c = sched(1000, 500, 600, 10)
    const d = sched(1000, 500, 600, 30)
    const e = sched(1000, 500, 600, 60)
    const f = sched(1000, 500, 600, 300)
    expect(computeCurrentPrice(c, 10 + 3)).toBe(992)   // N=60、每步 8
    expect(computeCurrentPrice(c, 600 + 3)).toBe(500)
    expect(computeCurrentPrice(d, 30 + 10)).toBe(975)  // N=20、每步 25
    expect(computeCurrentPrice(d, 600 + 10)).toBe(500)
    expect(computeCurrentPrice(e, 60 + 20)).toBe(950)  // N=10、每步 50
    expect(computeCurrentPrice(e, 600 + 20)).toBe(500)
    expect(computeCurrentPrice(f, 300 + 100)).toBe(750) // N=2、每步 250
    expect(computeCurrentPrice(f, 600 + 100)).toBe(500)
  })

  it('長時程：1500→1000、2 小時、每 1 分鐘 → N=120、每步 4、最後一步 24', () => {
    const cfg = sched(1500, 1000, 7200, 60)
    expect(computeCurrentPrice(cfg, 60 + 20)).toBe(1496)
    expect(computeCurrentPrice(cfg, 120 * 60 + 20)).toBe(1000)
    expect(dropScheduleSummary({ originalPrice: 1500, minimumPrice: 1000, priceIntervalSeconds: 60, dropTotalSeconds: 7200 }))
      .toMatchObject({ steps: 120, stepAmount: 4, lastDropAmount: 24 })
  })

  it('永遠不會低於底價、永遠不高於起始價（大量取樣）', () => {
    for (const cfg of [sched(399, 99, 600, 60), sched(999, 299, 1800, 60), sched(1000, 500, 600, 10)]) {
      for (let t = 0; t < 5000; t += 7) {
        const p = computeCurrentPrice(cfg, t)
        expect(p).toBeGreaterThanOrEqual(cfg.minimumPrice)
        expect(p).toBeLessThanOrEqual(cfg.originalPrice)
      }
    }
  })

  it('決定性：同一 elapsed 永遠同一價格（重新整理不變）', () => {
    const cfg = sched(999, 299, 1800, 60)
    for (const t of [0, 1, 60, 900, 1800, 5000]) {
      expect(computeCurrentPrice(cfg, t)).toBe(computeCurrentPrice(cfg, t))
    }
  })

  it('secondsToNextDrop：未到底回 1~間隔秒；到底回 0', () => {
    const cfg = sched(399, 99, 600, 60)
    expect(secondsToNextDrop(cfg, 0)).toBe(60)
    expect(secondsToNextDrop(cfg, 60 + 20)).toBe(40)
    expect(secondsToNextDrop(cfg, 600 + 1)).toBe(0)
    expect(secondsToNextDrop(cfg, 60000)).toBe(0)
    for (let t = 0; t < 600; t += 3) {
      const n = secondsToNextDrop(cfg, t)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(60)
    }
  })

  it('除不盡與設定錯誤的提示（後台即時預警用）', () => {
    // 總時間無法被間隔整除：400 秒 / 60 秒 → N=6、實際總時間 360 秒
    const s = dropScheduleSummary({ originalPrice: 1000, minimumPrice: 400, priceIntervalSeconds: 60, dropTotalSeconds: 400 })
    expect(s.steps).toBe(6)
    expect(s.timeExact).toBe(false)
    expect(s.effectiveTotalSeconds).toBe(360)
    // 底價 ≥ 起始價 → 不合法
    expect(dropScheduleSummary({ originalPrice: 100, minimumPrice: 100, priceIntervalSeconds: 60, dropTotalSeconds: 600 }).valid).toBe(false)
    // 總時間不足一個間隔 → N=0 → 不合法
    expect(dropScheduleSummary({ originalPrice: 1000, minimumPrice: 100, priceIntervalSeconds: 60, dropTotalSeconds: 30 }).valid).toBe(false)
    // 價差太小（每步不足 1 元）→ 不合法
    expect(dropScheduleSummary({ originalPrice: 100, minimumPrice: 90, priceIntervalSeconds: 1, dropTotalSeconds: 600 }).valid).toBe(false)
    // 變價次數過多（2 小時 ÷ 1 秒 = 7200 次）→ 不合法（防呆上限 1000）
    const tooMany = dropScheduleSummary({ originalPrice: 10000, minimumPrice: 1000, priceIntervalSeconds: 1, dropTotalSeconds: 7200 })
    expect(tooMany.steps).toBe(7200)
    expect(tooMany.valid).toBe(false)
    // 上限內仍合法（2 小時 ÷ 10 秒 = 720 次）
    expect(dropScheduleSummary({ originalPrice: 10000, minimumPrice: 1000, priceIntervalSeconds: 10, dropTotalSeconds: 7200 }).valid).toBe(true)
  })

  it('planDropSchedule：列數 = N+1、末列必為底價、單調不增', () => {
    for (const [orig, min, total, ivl] of [[399, 99, 600, 60], [999, 299, 1800, 60], [1000, 500, 600, 10], [1500, 1000, 7200, 60]]) {
      const plan = planDropSchedule({ originalPrice: orig, minimumPrice: min, priceIntervalSeconds: ivl, dropTotalSeconds: total })
      expect(plan.rows.length).toBe(plan.steps + 1)
      expect(plan.rows[0]).toMatchObject({ atSeconds: 0, price: orig, dropAmount: 0 })
      expect(plan.rows[plan.rows.length - 1].price).toBe(min)
      expect(plan.rows[plan.rows.length - 1].dropAmount).toBe(plan.lastDropAmount)
      for (let i = 1; i < plan.rows.length; i++) {
        expect(plan.rows[i].price).toBeLessThanOrEqual(plan.rows[i - 1].price)
        expect(plan.rows[i].atSeconds).toBe(i * ivl)
      }
    }
  })

  it('新模式不影響舊模式：dropTotalSeconds 為 null 時走舊隨機公式', () => {
    expect(computeScheduledPrice({ ...fixed, dropTotalSeconds: null }, 60)).toBeNull()
    expect(computeCurrentPrice({ ...fixed, dropTotalSeconds: null }, 60, 'p1')).toBe(
      computeCurrentPrice(fixed, 60, 'p1'),
    )
    expect(computeCurrentPrice(fixed, 60, 'p1')).toBe(1490)
  })

  it('formatDurationZh：中文時長', () => {
    expect(formatDurationZh(0)).toBe('0 秒')
    expect(formatDurationZh(30)).toBe('30 秒')
    expect(formatDurationZh(600)).toBe('10 分')
    expect(formatDurationZh(630)).toBe('10 分 30 秒')
    expect(formatDurationZh(7200)).toBe('2 小時')
    expect(formatDurationZh(3900)).toBe('1 小時 5 分')
  })
})

describe('回歸測試：新模式前台顯示價必須與 Server SQL（20260922）一致', () => {
  // 期望值由本機 PostgreSQL 16 實跑 public.compute_current_price 取得
  // （supabase/drop-schedule-migration-test.sql⑧ 的 PROBE 273 列，全數一致）
  const cases: Array<[number, number, number, number, number, number]> = [
    // orig, min, total, ivl, k, 期望價格
    [399, 99, 600, 60, 0, 399],
    [399, 99, 600, 60, 3, 309],
    [399, 99, 600, 60, 10, 99],
    [399, 99, 600, 60, 42, 99],
    [999, 299, 1800, 60, 1, 976],
    [999, 299, 1800, 60, 12, 723],
    [999, 299, 1800, 60, 29, 332],
    [999, 299, 1800, 60, 30, 299],
    [1000, 500, 600, 10, 59, 528],
    [1000, 500, 600, 30, 19, 525],
    [1000, 500, 600, 300, 1, 750],
    [1000, 500, 600, 300, 2, 500],
    [1500, 1000, 7200, 60, 119, 1024],
    [1500, 1000, 7200, 60, 120, 1000],
  ]
  it('逐點與 Server SQL 相同', () => {
    for (const [orig, min, total, ivl, k, expected] of cases) {
      const cfg = sched(orig, min, total, ivl)
      expect(computeCurrentPrice(cfg, k * ivl + 0.33 * ivl)).toBe(expected)
    }
  })
})

describe('工具函式', () => {
  it('secondsToNextDrop：12 小時週期', () => {
    expect(secondsToNextDrop({ ...fixed, priceIntervalSeconds: 43200 }, 3600)).toBe(39600)
  })

  it('secondsToNextDrop：已到底價 → 0（不再降）', () => {
    // fixed：S=50，k>=50 即到底
    expect(secondsToNextDrop(fixed, 50 * 60)).toBe(0)
    expect(secondsToNextDrop(fixed, 5000 * 60)).toBe(0)
  })

  it('formatCountdown 支援小時', () => {
    expect(formatCountdown(39600)).toBe('11:00:00')
    expect(formatCountdown(90)).toBe('01:30')
  })

  it('formatInterval 人性化', () => {
    expect(formatInterval(43200)).toBe('12 小時')
    expect(formatInterval(60)).toBe('1 分鐘')
    expect(formatInterval(45)).toBe('45 秒')
  })
})
