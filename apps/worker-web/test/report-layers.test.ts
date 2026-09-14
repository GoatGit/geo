import { describe, expect, it } from 'vitest';
import { aggregateQuestionLayers, type LayerFact } from '../src/report-builder';

const QUESTIONS = [{ id: 1, text: '哪些新能源车值得买?', type: 'ranking' }];

function facts(perEngine: Record<string, [boolean, number | null]>): LayerFact[] {
  return Object.entries(perEngine).map(([engine, [mentioned, rank]]) => ({
    questionId: 1,
    engine,
    mentioned,
    rank,
  }));
}

describe('aggregateQuestionLayers(docs/02 §5 问题分层,与控制台同口径)', () => {
  it('5 引擎全线 Top3 → L1', () => {
    const fs = facts({
      doubao: [true, 1],
      deepseek: [true, 2],
      wenxin: [true, 3],
      qwen: [true, 1],
      yuanbao: [true, 2],
    });
    expect(aggregateQuestionLayers(QUESTIONS, fs)[0]?.layer).toBe('L1');
  });

  it('3/5 引擎 Top3(占比 60%)→ L2', () => {
    const fs = facts({
      doubao: [true, 1],
      deepseek: [true, 2],
      wenxin: [true, 3],
      qwen: [true, 5],
      yuanbao: [false, null],
    });
    expect(aggregateQuestionLayers(QUESTIONS, fs)[0]?.layer).toBe('L2');
  });

  it('2/5 引擎 Top3 → L3;0/5 → L4', () => {
    const l3 = aggregateQuestionLayers(
      QUESTIONS,
      facts({ doubao: [true, 2], deepseek: [true, 4], wenxin: [false, null], qwen: [true, 7], yuanbao: [true, 9] }),
    )[0]?.layer;
    expect(l3).toBe('L3');
    const l4 = aggregateQuestionLayers(
      QUESTIONS,
      facts({ doubao: [false, null], deepseek: [true, 8], wenxin: [false, null], qwen: [true, 4], yuanbao: [true, 5] }),
    )[0]?.layer;
    expect(l4).toBe('L4');
  });

  it('同引擎多轮取最好位次(首轮回 5、次轮回 2 记 Top3)', () => {
    const fs: LayerFact[] = [
      { questionId: 1, engine: 'doubao', mentioned: true, rank: 5 },
      { questionId: 1, engine: 'doubao', mentioned: true, rank: 2 },
      { questionId: 1, engine: 'deepseek', mentioned: true, rank: 1 },
      { questionId: 1, engine: 'wenxin', mentioned: true, rank: 4 },
    ];
    const layers = aggregateQuestionLayers(QUESTIONS, fs);
    // 引擎数 = 3(doubao 去重),top3 = 2 → 66% → L2
    expect(layers[0]?.layer).toBe('L2');
  });

  it('参采引擎 N<3 不分层(样本不足)', () => {
    const fs = facts({ doubao: [true, 1], deepseek: [false, null] });
    expect(aggregateQuestionLayers(QUESTIONS, fs)[0]?.layer).toBeNull();
  });

  it('无关问题的事实不串扰', () => {
    const fs: LayerFact[] = [
      { questionId: 99, engine: 'doubao', mentioned: true, rank: 1 },
      { questionId: 99, engine: 'deepseek', mentioned: true, rank: 1 },
      { questionId: 99, engine: 'wenxin', mentioned: true, rank: 1 },
    ];
    expect(aggregateQuestionLayers(QUESTIONS, fs)[0]?.layer).toBeNull();
  });
});
