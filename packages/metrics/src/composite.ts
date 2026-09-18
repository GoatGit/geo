/**
 * 综合名次(docs/02 §1.3,2026-09 决策:未上榜记 N+1 取中位数)。
 * - N = 该问题本轮实际参采引擎数(状态为 ok_* 的引擎数)
 * - 归一:未上榜 / 散文提及(rank=null)→ N+1
 * - 聚合:中位数;偶数个取中间两值算术平均并向上取整(评价偏保守)
 * - 校验样例:未上榜/#3/未上榜/#5/#1, N=5 → [6,3,6,5,1] → 中位数 5
 */
export function compositeRank(
  entries: Array<{ mentioned: boolean; rank: number | null }>,
  enginesCollected: number,
): number | null {
  if (enginesCollected <= 0) return null;
  if (entries.length === 0) return null; // 空条目:sorted[-1] 为 undefined,避免返回 NaN
  const n = enginesCollected;
  const normalized = entries.map((e) =>
    e.mentioned && e.rank !== null ? e.rank : n + 1,
  );
  const sorted = [...normalized].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : Math.ceil((sorted[mid - 1] + sorted[mid]) / 2);
  return median;
}

/** 多轮/多问题综合名次的趋势均值(日结层固化用,docs/05 §4)。 */
export function averageCompositeRanks(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  if (v.length === 0) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
}
