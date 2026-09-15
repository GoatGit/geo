import { describe, expect, it } from 'vitest';
import type { HeatmapBlock, TrendBlock } from '@geo/shared';
import { composeIndustryInsight, type IndustryAggregates } from '../src/insight-builder';

/** 合成聚合输入:2 品牌、2 引擎、完整漏斗/信源/口碑/趋势。 */
function fixture(): IndustryAggregates {
  const mk = (brandId: number, name: string, valid: number, mentioned: number, top3: number, top1: number): IndustryAggregates['brands'][number] => ({
    brandId,
    name,
    valid,
    mentioned,
    ranked: mentioned,
    top3,
    top1,
    avgRank: mentioned ? 2.1 : null,
    questions: 10,
    answers: valid,
    failed: 1,
    quotaBlocked: 2,
  });
  return {
    industry: '测试行业',
    windowDays: 30,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T00:00:00.000Z',
    brands: [mk(1, '品牌A', 100, 80, 50, 20), mk(2, '品牌B', 100, 40, 10, 2)],
    engineHits: [
      { brandId: 1, engine: 'doubao', rate: 0.9, valid: 50 },
      { brandId: 1, engine: 'deepseek', rate: 0.7, valid: 50 },
      { brandId: 2, engine: 'doubao', rate: 0.5, valid: 50 },
      { brandId: 2, engine: 'deepseek', valid: 0, rate: 0 },
    ],
    funnel: { answers: 200, mentioned: 120, top3: 60, top1: 22 },
    landscape: [
      { name: '品牌A', kind: 'self', mentions: 80, runs: 60 },
      { name: '竞品X', kind: 'competitor', mentions: 55, runs: 40 },
      { name: '黑马Y', kind: 'discovered', mentions: 30, runs: 25 },
    ],
    citations: {
      total: 300,
      owned: 36,
      ownedShare: 0.12,
      top: [{ domain: 'zhihu.com', platform: '社区', category: 'ugc', hits: 90 }],
      categories: [{ category: 'ugc', hits: 90 }],
    },
    reputation: {
      total: 50,
      pos: 35,
      neu: 10,
      neg: 5,
      posTerms: [{ term: '性价比高', count: 12 }],
      negTerms: [{ term: '售后慢', count: 4 }],
    },
    trend: [
      { date: '2026-08-01', valid: 30, rate: 0.7 },
      { date: '2026-08-02', valid: 28, rate: 0.75 },
      { date: '2026-08-03', valid: 0, rate: null },
      { date: '2026-08-04', valid: 32, rate: 0.8 },
    ],
  };
}

describe('行业洞察组稿(运行 → 数据报告)', () => {
  it('生成完整块集:格局/排行/漏斗/热力/口碑/信源/雷达/趋势/象限/实体', () => {
    const c = composeIndustryInsight(fixture());
    const types = c.blocks.map((b) => b.type);
    expect(types).toContain('takeaway');
    expect(types).toContain('barRank');
    expect(types).toContain('funnel');
    expect(types).toContain('heatmap');
    expect(types).toContain('radar');
    expect(types).toContain('trend');
    expect(types).toContain('scatter');
    // 4 张 barRank:提及率排行 + 信源 + 实体榜(≥2)
    expect(types.filter((t) => t === 'barRank').length).toBeGreaterThanOrEqual(2);
  });

  it('标题/封面/摘要带头部品牌与样本量', () => {
    const c = composeIndustryInsight(fixture());
    expect(c.title).toBe('测试行业行业 AI 可见度洞察');
    expect(c.cover.headline).toContain('品牌A');
    expect(c.cover.headline).toContain('80%');
    expect(c.cover.brands).toBe(2);
    expect(c.cover.answers).toBe(200);
    expect(c.summary).toContain('品牌A');
  });

  it('热力图无样本引擎为 null(渲染空白),有样本为 0-1', () => {
    const c = composeIndustryInsight(fixture());
    const heat = c.blocks.find((b) => b.type === 'heatmap') as HeatmapBlock;
    // 列按字典序:deepseek 在前,doubao 在后
    const b2 = heat.rows.find((r) => r.name === '品牌B')!;
    expect(heat.columns).toEqual(['deepseek', 'doubao']);
    expect(b2.cells[0]).toBeNull();
    expect(b2.cells[1]).toBeCloseTo(0.5);
  });

  it('趋势断点保留 null,值换算为百分比标度', () => {
    const c = composeIndustryInsight(fixture());
    const trend = c.blocks.find((b) => b.type === 'trend') as TrendBlock;
    expect(trend.points[2].value).toBeNull();
    expect(trend.points[0].value).toBeCloseTo(70);
  });

  it('行业无品牌/无数据时:不产生空除崩溃,产出可渲染的最小报告', () => {
    const empty = fixture();
    empty.brands = [];
    empty.funnel = { answers: 0, mentioned: 0, top3: 0, top1: 0 };
    empty.trend = [];
    empty.citations.total = 0;
    empty.citations.top = [];
    empty.reputation.total = 0;
    empty.landscape = [];
    empty.engineHits = [];
    const c = composeIndustryInsight(empty);
    expect(c.blocks.length).toBe(0);
    expect(c.summary).toContain('暂无可聚合');
  });
});
