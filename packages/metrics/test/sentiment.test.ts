import { describe, expect, it } from 'vitest';
import { aggregateImpressions, sentimentScore, topImpressions } from '../src/sentiment';

describe('sentiment(docs/02 §4)', () => {
  it('情绪得分归一化负分制:(正面+0.5×中性−负面)/有效×100,值域 −100..+100;无数据为 null', () => {
    expect(sentimentScore(41, 0, 0, 58)).toBe(71);
    // 理想口碑实测案例:12 中性 + 1 负面 → (0 + 6 − 1)/13 ≈ 38,60 分以下判负面档
    expect(sentimentScore(0, 12, 1, 13)).toBe(38);
    // 全负面打负分
    expect(sentimentScore(0, 0, 5, 5)).toBe(-100);
    // 全中性落在 50(中性档),仍低于 60 及格线
    expect(sentimentScore(0, 10, 0, 10)).toBe(50);
    expect(sentimentScore(1, 0, 0, 0)).toBeNull();
  });

  it('印象词按词种计数(非出现次数),同义归并生效', () => {
    const merged = aggregateImpressions(
      [
        { term: '价格高', polarity: 'neg', excerpt: 'e1' },
        { term: '贵', polarity: 'neg', excerpt: 'e2' },
        { term: '价格高', polarity: 'neg', excerpt: 'e3' },
        { term: '技术领先', polarity: 'pos', excerpt: 'e4' },
      ],
      { 贵: '价格高' },
    );
    const price = merged.find((i) => i.term === '价格高')!;
    expect(price.runs).toBe(3); // 3 次出现 = 1 个词种 × runs 计数,归并后同一词条
    expect(price.excerpts.length).toBe(3);
  });

  it('优势/待攻各取 TOP6,极性不混', () => {
    const inputs = [
      ...Array.from({ length: 8 }, (_, i) => ({
        term: `优${i}`,
        polarity: 'pos' as const,
        excerpt: 'x',
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        term: `劣${i}`,
        polarity: 'neg' as const,
        excerpt: 'y',
      })),
    ];
    const { strengths, weaknesses } = topImpressions(inputs);
    expect(strengths).toHaveLength(6);
    expect(weaknesses).toHaveLength(6);
    expect(strengths.every((s) => s.polarity === 'pos')).toBe(true);
    expect(weaknesses.every((s) => s.polarity === 'neg')).toBe(true);
  });

  it('每个印象词至少携带 1 条原文摘录(证据链要求)', () => {
    const merged = aggregateImpressions([{ term: '耐用', polarity: 'pos', excerpt: '车身耐用性口碑好' }]);
    expect(merged[0].excerpts.length).toBeGreaterThanOrEqual(1);
  });
});
