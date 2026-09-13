import type { FunnelStage } from '@geo/shared';

export interface FunnelCounts {
  /** 有效 QueryRun(ok_with_answer + ok_empty) */
  valid: number;
  mentioned: number;
  top3: number;
  top1: number;
}

/**
 * 可见性漏斗(docs/02 §2 嵌套转化口径,2026-09 修订):
 * ① 提及 = mentioned / valid;② 上榜 = top3 / mentioned;③ 首推 = top1 / top3。
 * 单调性由嵌套集合保证(②③恒 ≤100%),散文式提及计入 ② 分母。
 */
export function computeFunnel(c: FunnelCounts): FunnelStage[] {
  const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
  return [
    {
      key: 'mention',
      label: '提及',
      numerator: c.mentioned,
      denominator: c.valid,
      rate: rate(c.mentioned, c.valid),
      denominatorNote: '全部有效 QueryRun(ok_with_answer + ok_empty)',
    },
    {
      key: 'top3',
      label: '上榜(Top3)',
      numerator: c.top3,
      denominator: c.mentioned,
      rate: rate(c.top3, c.mentioned),
      denominatorNote: '①的分子:被提及的 QueryRun',
    },
    {
      key: 'top1',
      label: '首推(位次=1)',
      numerator: c.top1,
      denominator: c.top3,
      rate: rate(c.top1, c.top3),
      denominatorNote: '②的分子:进 Top3 的 QueryRun',
    },
  ];
}
