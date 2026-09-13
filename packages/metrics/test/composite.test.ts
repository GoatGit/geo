import { describe, expect, it } from 'vitest';
import { averageCompositeRanks, compositeRank } from '../src/composite';

describe('compositeRank(docs/02 §1.3)', () => {
  it('校验样例:未上榜/#3/未上榜/#5/#1, N=5 → [6,3,6,5,1] → 中位数 5', () => {
    const entries = [
      { mentioned: false, rank: null },
      { mentioned: true, rank: 3 },
      { mentioned: false, rank: null },
      { mentioned: true, rank: 5 },
      { mentioned: true, rank: 1 },
    ];
    expect(compositeRank(entries, 5)).toBe(5);
  });

  it('散文式提及(mentioned=true, rank=null)记 N+1', () => {
    const entries = [
      { mentioned: true, rank: null }, // 散文提及 → 4
      { mentioned: true, rank: 2 },
      { mentioned: true, rank: 4 },
    ];
    // 归一 [4,2,4] → 排序 [2,4,4] → 中位数 4
    expect(compositeRank(entries, 3)).toBe(4);
  });

  it('全线出局 → N+1', () => {
    const entries = [
      { mentioned: false, rank: null },
      { mentioned: false, rank: null },
      { mentioned: false, rank: null },
    ];
    expect(compositeRank(entries, 3)).toBe(4);
  });

  it('偶数个取中间两值算术平均并向上取整(保守)', () => {
    const entries = [
      { mentioned: true, rank: 1 },
      { mentioned: true, rank: 2 },
      { mentioned: true, rank: 4 },
      { mentioned: true, rank: 4 },
    ];
    // [1,2,4,4] → (2+4)/2 = 3 → ceil(3) = 3
    expect(compositeRank(entries, 4)).toBe(3);
    const entries2 = [
      { mentioned: true, rank: 1 },
      { mentioned: true, rank: 2 },
    ];
    // [1,2] → 1.5 → ceil = 2
    expect(compositeRank(entries2, 2)).toBe(2);
  });

  it('无参采引擎返回 null', () => {
    expect(compositeRank([], 0)).toBeNull();
  });

  it('averageCompositeRanks:忽略 null,保留 1 位小数', () => {
    expect(averageCompositeRanks([5, null, 4])).toBe(4.5);
    expect(averageCompositeRanks([])).toBeNull();
  });
});
