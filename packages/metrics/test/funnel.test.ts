import { describe, expect, it } from 'vitest';
import { computeFunnel } from '../src/funnel';
import { classifyLayer } from '../src/layering';
import { aggregateDaily } from '../src/daily';

describe('computeFunnel(docs/02 §2 嵌套转化)', () => {
  it('嵌套分母:提及=有效,上榜=被提及,首推=进 Top3', () => {
    const stages = computeFunnel({ valid: 40, mentioned: 29, top3: 24, top1: 23 });
    expect(stages[0]).toMatchObject({ numerator: 29, denominator: 40 });
    expect(stages[1]).toMatchObject({ numerator: 24, denominator: 29 });
    expect(stages[2]).toMatchObject({ numerator: 23, denominator: 24 });
    expect(stages[1].rate).toBeCloseTo(0.828, 2);
    expect(stages[2].rate).toBeCloseTo(0.958, 2);
  });

  it('单调性:②③恒 ≤100%(漏斗不倒挂)', () => {
    // 散文提及多的极端 case:40 有效、29 提及但仅 10 有名次且全部进 Top3
    const stages = computeFunnel({ valid: 40, mentioned: 29, top3: 10, top1: 10 });
    expect(stages[1].rate!).toBeLessThanOrEqual(1);
    expect(stages[2].rate!).toBeLessThanOrEqual(1);
  });

  it('分母为 0 时 rate 为 null(不显示误导性 0%)', () => {
    const stages = computeFunnel({ valid: 0, mentioned: 0, top3: 0, top1: 0 });
    stages.forEach((s) => expect(s.rate).toBeNull());
  });
});

describe('classifyLayer(docs/02 §5)', () => {
  it('L1-L4 边界', () => {
    expect(classifyLayer(5, 5)).toBe('L1');
    expect(classifyLayer(4, 5)).toBe('L2'); // 0.8 ≥ 0.6
    expect(classifyLayer(3, 5)).toBe('L2'); // 0.6 ≥ 0.6
    expect(classifyLayer(2, 5)).toBe('L3');
    expect(classifyLayer(1, 5)).toBe('L3');
    expect(classifyLayer(0, 5)).toBe('L4');
  });

  it('N<3 不分层(样本不足)', () => {
    expect(classifyLayer(2, 2)).toBeNull();
    expect(classifyLayer(0, 1)).toBeNull();
  });
});

describe('aggregateDaily(docs/02 §1.1 分母规则)', () => {
  const facts = [
    { status: 'ok_with_answer' as const, engine: 'doubao', mentioned: true, rank: 1, compositeRank: 1 },
    { status: 'ok_with_answer' as const, engine: 'deepseek', mentioned: true, rank: 3, compositeRank: 3 },
    { status: 'ok_empty' as const, engine: 'wenxin', mentioned: false, rank: null },
    { status: 'failed' as const, engine: 'qwen', mentioned: false, rank: null },
    { status: 'quota_blocked' as const, engine: 'yuanbao', mentioned: false, rank: null },
  ];

  it('分母只计 ok_with_answer + ok_empty;failed/quota_blocked 进 excluded 且可见', () => {
    const agg = aggregateDaily(facts);
    expect(agg.valid).toBe(3);
    expect(agg.excludedFailed).toBe(1);
    expect(agg.excludedQuotaBlocked).toBe(1);
    expect(agg.mentionRate).toBeCloseTo(0.667, 2); // 2/3
    expect(agg.top3Rate).toBe(1); // 2/2(有名次的都进 Top3)
    expect(agg.top1Rate).toBe(0.5); // 1/2
    expect(agg.avgRank).toBe(2); // (1+3)/2
    expect(agg.avgCompositeRank).toBe(2);
  });

  it('全失败时各率为 null 而非 0(空态诚实,docs/00 教训 #5)', () => {
    const agg = aggregateDaily([{ status: 'failed', engine: 'doubao', mentioned: false, rank: null }]);
    expect(agg.mentionRate).toBeNull();
    expect(agg.top3Rate).toBeNull();
    expect(agg.avgRank).toBeNull();
  });
});
