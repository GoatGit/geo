import { describe, expect, it } from 'vitest';
import { generateActionList, type RulesContext } from '../src/rules';
import { RULESET_VERSION } from '@geo/shared';

const base: RulesContext = {
  layers: [],
  metrics: { mentionRate: 0.9, top3Rate: 0.7, top1Rate: 0.5 },
  engineStats: [],
  competitorCitations: [],
  sentimentScore: 75,
  negativeImpressions: [],
};

describe('generateActionList(docs/02 §6 规则引擎)', () => {
  it('R-P0-L4:存在全线缺席问题', () => {
    const r = generateActionList({
      ...base,
      metrics: null,
      layers: [{ questionId: 1, text: '2026 最值得买的新能源品牌', layer: 'L4' }],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ priority: 'P0', ruleId: 'R-P0-L4' });
    expect(r.items[0].action).toContain('2026 最值得买的新能源品牌');
    expect(r.rulesetVersion).toBe(RULESET_VERSION);
  });

  it('R-P0-FIRST-POSITION:首推率<60% 且 Top3 率≥60%', () => {
    const r = generateActionList(base);
    expect(r.items.map((i) => i.ruleId)).toContain('R-P0-FIRST-POSITION');
  });

  it('R-P1-ENGINE-GAP:单引擎三率差均值 >15pct', () => {
    const r = generateActionList({
      ...base,
      metrics: null,
      engineStats: [
        { engine: 'doubao', mentionRate: 0.9, top3Rate: 0.7, top1Rate: 0.5 },
        { engine: 'deepseek', mentionRate: 0.9, top3Rate: 0.7, top1Rate: 0.5 },
        { engine: 'yuanbao', mentionRate: 0.4, top3Rate: 0.3, top1Rate: 0.1 },
      ],
    });
    const gap = r.items.find((i) => i.ruleId === 'R-P1-ENGINE-GAP')!;
    expect(gap).toBeDefined();
    expect(gap.action).toContain('yuanbao');
  });

  it('R-P1-CITATION-GAP:竞对被引 ≥3× 我方(且 ≥3 次)', () => {
    const r = generateActionList({
      ...base,
      metrics: null,
      competitorCitations: [{ platform: '知乎', competitorCount: 9, ownCount: 2 }],
    });
    expect(r.items.map((i) => i.ruleId)).toContain('R-P1-CITATION-GAP');
  });

  it('被引噪声不触发:竞对 2 次 vs 我方 0 次不触发', () => {
    const r = generateActionList({
      ...base,
      metrics: null,
      competitorCitations: [{ platform: '知乎', competitorCount: 2, ownCount: 0 }],
    });
    expect(r.items).toHaveLength(0);
  });

  it('R-P2 系列:情绪低分 + 价格/服务类负面印象', () => {
    const r = generateActionList({
      ...base,
      metrics: null,
      sentimentScore: 45,
      negativeImpressions: [
        { term: '溢价高', count: 4 },
        { term: '智能化弱', count: 2 },
      ],
    });
    expect(r.items.map((i) => i.ruleId)).toContain('R-P2-SENTIMENT');
    expect(r.items.map((i) => i.ruleId)).toContain('R-P2-PRICE-SERVICE');
  });

  it('输出按 P0 < P1 < P2 稳定排序', () => {
    const r = generateActionList({
      ...base,
      metrics: { mentionRate: 0.9, top3Rate: 0.7, top1Rate: 0.5 },
      layers: [{ questionId: 1, text: 'x', layer: 'L4' }],
      sentimentScore: 45,
    });
    const priorities = r.items.map((i) => i.priority);
    expect(priorities).toEqual([...priorities].sort());
  });
});
