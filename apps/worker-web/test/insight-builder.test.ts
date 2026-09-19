import { describe, expect, it } from 'vitest';
import type { BarRankBlock, FunnelBlock, HeatmapBlock, TrendBlock } from '@geo/shared';
import { composeIndustryInsight, type IndustryAggregates } from '../src/insight-builder';
import type { BarRankBlock, RadarBlock } from '@geo/shared';

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
    repTotal: name === '品牌A' ? 20 : 10,
    repPos: name === '品牌A' ? 16 : 3,
    repNeg: name === '品牌A' ? 1 : 4,
    ownedHits: name === '品牌A' ? 12 : 0,
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

  it('雷达五维全部为品牌归属真实值:口碑/官网被引不再共享行业值', () => {
    const c = composeIndustryInsight(fixture());
    const radar = c.blocks.find((b) => b.type === 'radar') as RadarBlock;
    expect(radar.axes).toEqual(['提及率', 'Top3率', '首位率', '口碑正面', '官网被引']);
    const a = radar.series.find((s) => s.name === '品牌A')!;
    const b = radar.series.find((s) => s.name === '品牌B')!;
    // 品牌A:口碑正面 16/20=0.8,官网被引 12/300=0.04;品牌B:3/10=0.3,0
    expect(a.values[3]).toBeCloseTo(0.8);
    expect(a.values[4]).toBeCloseTo(0.04);
    expect(b.values[3]).toBeCloseTo(0.3);
    expect(b.values[4]).toBe(0);
  });

  it('品牌口碑正面率排行出块:n 携带口碑回答数', () => {
    const c = composeIndustryInsight(fixture());
    const rank = c.blocks.find((b) => b.type === 'barRank' && b.title === '品牌口碑正面率排行') as BarRankBlock;
    expect(rank).toBeTruthy();
    expect(rank.items).toEqual([
      { name: '品牌A', value: 80, n: 20 },
      { name: '品牌B', value: 30, n: 10 },
    ]);
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
    expect(c.blocks.length).toBe(1); // 仅剩开篇「数据说明」块
    expect(c.blocks[0]!.title).toBe('数据说明');
    expect(c.summary).toContain('暂无可聚合');
  });

  it('精品化组稿:每图带图上总结,无内部枚举与散落口径公式', () => {
    const c = composeIndustryInsight(fixture());
    const dump = JSON.stringify(c.blocks);
    // 内部枚举与口径公式不得出现在报告内容中(口径统一收进页脚)
    expect(dump).not.toContain('ok_with_answer');
    expect(dump).not.toContain('提及率 =');
    // 每个图表块都有图上总结
    const charts = c.blocks.filter((b) => b.type !== 'takeaway');
    for (const chart of charts) {
      expect((chart as { summary?: string }).summary?.length ?? 0).toBeGreaterThan(8);
    }
    // 漏斗层标签用自然语言
    const funnel = c.blocks.find((b) => b.type === 'funnel') as FunnelBlock;
    expect(funnel.stages[0]!.note).toBe('返回了实质内容的回答');
    expect(funnel.summary).toContain('1 次把监测品牌推上首位');
  });

  it('图上总结是数据驱动的:排行/趋势/象限/信源各不相同', () => {
    const c = composeIndustryInsight(fixture());
    const summaries = c.blocks
      .filter((b) => b.type !== 'takeaway')
      .map((b) => (b as { summary?: string }).summary ?? '');
    expect(new Set(summaries).size).toBe(summaries.length); // 互不相同
    const rank = c.blocks.find((b) => b.type === 'barRank') as BarRankBlock;
    expect(rank.summary).toContain('品牌A');
    const trend = c.blocks.find((b) => b.type === 'trend') as TrendBlock;
    expect(trend.summary).toContain('抬升');
  });

  it('口碑文案:自然语言引用印象词,而非 ×N 罗列', () => {
    const c = composeIndustryInsight(fixture());
    const rep = c.blocks.find((b) => b.title === '口碑与印象')!;
    expect(JSON.stringify(rep)).toContain('性价比高');
    expect(JSON.stringify(rep)).not.toContain('×12');
  });

  it('环比:传入上期基线后 items 带 delta,summary 出现变动叙述', () => {
    const c = composeIndustryInsight(fixture(), new Map([['品牌A', 0.5], ['品牌B', 0.5]]));
    const rank = c.blocks.find((b) => b.type === 'barRank') as BarRankBlock;
    const a = rank.items.find((i) => i.name === '品牌A')!;
    const b = rank.items.find((i) => i.name === '品牌B')!;
    expect(a.delta).toBeCloseTo(30); // 80% - 50%
    expect(b.delta).toBeCloseTo(-10); // 40% - 50%
    expect(rank.summary).toContain('较上期');
    expect(rank.summary).toContain('品牌A 提升');
    expect(rank.items.every((i) => typeof i.n === 'number' && i.n! > 0)).toBe(true);
  });

  it('首期报告(无上期):items 无 delta,不出现环比叙述', () => {
    const c = composeIndustryInsight(fixture());
    const rank = c.blocks.find((b) => b.type === 'barRank') as BarRankBlock;
    expect(rank.items.every((i) => i.delta === undefined)).toBe(true);
    expect(rank.summary ?? '').not.toContain('较上期');
  });

  it('小样本守门:样本不足的品牌不进 headline/格局叙述,数据说明块披露', () => {
    const thin = fixture();
    // 品牌B 仅 2 条有效回答且 2 次都被提及(100%)——典型噪声数据
    thin.brands = thin.brands.map((b) => (b.name === '品牌B' ? { ...b, valid: 2, mentioned: 2, ranked: 2, top3: 2, top1: 2 } : b));
    const c = composeIndustryInsight(thin);
    expect(c.cover.headline).toContain('品牌A'); // headline 由样本充足的 A 担纲
    expect(c.cover.headline).not.toContain('100% · 品牌B');
    const note = c.blocks.find((b) => b.title === '数据说明')!;
    expect(JSON.stringify(note)).toContain('品牌B');
    const rank = c.blocks.find((b) => b.type === 'barRank') as BarRankBlock;
    const b2 = rank.items.find((i) => i.name === '品牌B')!;
    expect(b2.n).toBe(2); // 数据仍展示,但披露样本量
    expect(b2.delta).toBeUndefined(); // 小样本不参与环比
    // 格局叙述只讲样本充足的 A
    const landscape = c.blocks.find((b) => b.title === 'AI 眼中的行业格局')!;
    expect(JSON.stringify(landscape)).not.toContain('品牌B');
  });
});
