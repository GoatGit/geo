import { describe, expect, it } from 'vitest';
import { buildLayerPrompt } from '../src/prompts';
import { validateLayerOutput } from '../src/schema';
import { INSIGHT_QUESTION_LAYERS } from '@geo/shared';

const qs = ['护肤品哪些品牌值得买?', '雅诗兰黛和兰蔻怎么选?', '行业前十的护肤品牌有哪些?'];

describe('buildLayerPrompt(分层补齐)', () => {
  it('prompt 带五层清单、判定规则与逐字问题列表', () => {
    const { system, user } = buildLayerPrompt({ industry: '护肤品', questions: qs, layers: INSIGHT_QUESTION_LAYERS });
    for (const layer of INSIGHT_QUESTION_LAYERS) expect(system).toContain(layer);
    expect(system).toContain('品类行业层');
    expect(user).toContain(qs[2]);
  });
});

describe('validateLayerOutput(宁缺毋滥)', () => {
  it('合法条目接受:逐字匹配问题 + 白名单层', () => {
    const r = validateLayerOutput(
      { items: [
        { q: qs[0], layer: '场景人群层' },
        { q: qs[1], layer: '竞品层' },
      ] },
      { questions: qs, layers: INSIGHT_QUESTION_LAYERS },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.items).toHaveLength(2);
  });

  it('层名越权 / 编造问题 / 重复条目全部丢弃,其余保留', () => {
    const r = validateLayerOutput(
      { items: [
        { q: qs[0], layer: '神秘层' },
        { q: '编造的问题?', layer: '竞品层' },
        { q: qs[2], layer: '品类行业层' },
        { q: qs[2], layer: '品类行业层' },
      ] },
      { questions: qs, layers: INSIGHT_QUESTION_LAYERS },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.items).toEqual([{ q: qs[2], layer: '品类行业层' }]);
  });

  it('全部无效 → 拒绝(调用方跳过回写,不猜)', () => {
    const r = validateLayerOutput({ items: [{ q: qs[0], layer: '不对' }] }, { questions: qs, layers: INSIGHT_QUESTION_LAYERS });
    expect(r.ok).toBe(false);
    expect(validateLayerOutput({ nope: 1 }, { questions: qs, layers: INSIGHT_QUESTION_LAYERS }).ok).toBe(false);
  });
});
