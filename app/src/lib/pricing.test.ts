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

  it('到底價後重新開始：下一個週期回到接近原價', () => {
    // S=50 → k=51 起為新一輪第 1 步
    const p = computeCurrentPrice(fixed, 51 * 60, 'p1')
    expect(p).toBe(1490) // 固定降幅：新輪第一步 = 原-10
    // 再跑 50 步又會觸底一次
    expect(computeCurrentPrice(fixed, 100 * 60, 'p1')).toBe(1000)
    expect(computeCurrentPrice(fixed, 101 * 60, 'p1')).toBe(1490)
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

describe('工具函式', () => {
  it('secondsToNextDrop：12 小時週期', () => {
    expect(secondsToNextDrop({ ...fixed, priceIntervalSeconds: 43200 }, 3600)).toBe(39600)
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
