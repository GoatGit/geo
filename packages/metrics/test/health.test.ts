import { DEFAULT_HEALTH_THRESHOLDS } from '@geo/shared';
import { describe, expect, it } from 'vitest';
import { evaluateHealth } from '../src/health';

describe('evaluateHealth(docs/02 §3)', () => {
  const input = {
    mentionRate: 0.73,
    top3Rate: 0.6,
    top1Rate: 0.58,
    avgRank: 2.1,
    sentimentScore: 56,
    ownedCitationShare: 0.05,
    ownedCitationCount: 5,
  };

  it('按阈值逐项判达标,汇总"N 项达标 · M 项需提升"', () => {
    const r = evaluateHealth(input, DEFAULT_HEALTH_THRESHOLDS, false);
    const byMetric = Object.fromEntries(r.items.map((i) => [i.metric, i]));
    expect(byMetric.mentionRate.pass).toBe(false); // 73% < 85%
    expect(byMetric.top3Rate.pass).toBe(true); // 60% ≥ 60%
    expect(byMetric.top1Rate.pass).toBe(false); // 58% < 60%
    expect(byMetric.avgRank.pass).toBe(false); // 2.1 > 2.0
    expect(byMetric.sentimentScore.pass).toBe(false); // 56 < 60
    expect(byMetric.ownedCitationShare.pass).toBe(false); // 5% < 8%
    expect(r.summary).toBe('1 项达标 · 5 项需提升');
    expect(byMetric.sentimentScore.label).toBe('需关注');
    expect(byMetric.ownedCitationShare.label).toBe('话语权薄弱');
  });

  it('灰度期标签附"校准中"', () => {
    const r = evaluateHealth(input, DEFAULT_HEALTH_THRESHOLDS, true);
    expect(r.items.every((i) => i.pass === null || i.label.includes('校准中'))).toBe(true);
  });

  it('无数据项 pass=null 且标签为"暂无数据"', () => {
    const r = evaluateHealth({}, DEFAULT_HEALTH_THRESHOLDS, false);
    expect(r.items.every((i) => i.pass === null)).toBe(true);
    expect(r.summary).toBe('暂无数据');
  });

  it('自有信源占比达标但条数不足 → 不达标(占比+绝对双门槛)', () => {
    const r = evaluateHealth(
      { ownedCitationShare: 0.2, ownedCitationCount: 3 },
      DEFAULT_HEALTH_THRESHOLDS,
      false,
    );
    expect(r.items.find((i) => i.metric === 'ownedCitationShare')!.pass).toBe(false);
  });
});
