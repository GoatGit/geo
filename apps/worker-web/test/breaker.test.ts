import { describe, expect, it } from 'vitest';
import { BREAKER_MIN_SAMPLES, computeTrip } from '../src/breaker';

describe('computeTrip(docs/04 §5 引擎熔断决策)', () => {
  it('样本不足不熔断(冷启动/低流量引擎不被单次失败误杀)', () => {
    expect(computeTrip(0, BREAKER_MIN_SAMPLES - 1, 0.3)).toBe(false);
    expect(computeTrip(0, 0, 0.3)).toBe(false);
  });

  it('失败率严格大于阈值才熔断(恰在阈值不触发)', () => {
    // 30 失败 / 70 成功 = 30% = 阈值 → 不熔断
    expect(computeTrip(70, 30, 0.3)).toBe(false);
    // 31 失败 / 69 成功 ≈ 31% > 阈值 → 熔断
    expect(computeTrip(69, 31, 0.3)).toBe(true);
  });

  it('大面积 ok_empty 空回答率同样计入失败(教训 #5)', () => {
    expect(computeTrip(5, 20, 0.3)).toBe(true);
  });

  it('零失败永不熔断', () => {
    expect(computeTrip(100, 0, 0.3)).toBe(false);
  });
});
