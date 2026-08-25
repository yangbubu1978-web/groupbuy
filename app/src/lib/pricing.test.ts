import { describe, it, expect } from 'vitest'
import {
  computeCurrentPrice,
  secondsToNextDrop,
  formatCountdown,
  formatInterval,
  randStep,
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
