import { type HealthThresholds } from '@geo/shared';

export interface HealthInput {
  mentionRate?: number | null;
  top3Rate?: number | null;
  top1Rate?: number | null;
  avgRank?: number | null;
  sentimentScore?: number | null;
  ownedCitationShare?: number | null;
  ownedCitationCount?: number | null;
}

export interface HealthItem {
  metric: keyof HealthInput;
  value: number | null;
  target: string;
  pass: boolean | null;
  /** docs/02 §3:前四项"需提升",情绪"需关注",自有信源"话语权薄弱" */
  label: string;
  calibrating: boolean;
}

export interface HealthReport {
  items: HealthItem[];
  passed: number;
  total: number;
  summary: string;
}

/**
 * 体检标签(docs/02 §3,2026-09 决策:数值沿用行业水位,方法论自有 =
 * 行业 P75 分位 + 8 周重校)。calibrating=true 时(灰度期)标签附"校准中"。
 */
export function evaluateHealth(
  input: HealthInput,
  thresholds: HealthThresholds,
  calibrating = false,
): HealthReport {
  const pct = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1000) / 1000);
  const items: HealthItem[] = [];

  const push = (
    metric: keyof HealthInput,
    value: number | null | undefined,
    pass: boolean | null,
    target: string,
    label: string,
  ) => {
    items.push({
      metric,
      value: value == null ? null : (pct(value) as number),
      target,
      pass,
      label: pass === null ? '暂无数据' : calibrating ? `${label}(校准中)` : label,
      calibrating: pass !== null && calibrating,
    });
  };

  const cmpRate = (v: number | null | undefined, target: number) =>
    v == null ? null : v >= target;
  const cmpRank = (v: number | null | undefined, target: number) => (v == null ? null : v <= target);

  push('mentionRate', pct(input.mentionRate), cmpRate(input.mentionRate, thresholds.mentionRate),
    `≥ ${Math.round(thresholds.mentionRate * 100)}%`, '需提升');
  push('top3Rate', pct(input.top3Rate), cmpRate(input.top3Rate, thresholds.top3Rate),
    `≥ ${Math.round(thresholds.top3Rate * 100)}%`, '需提升');
  push('top1Rate', pct(input.top1Rate), cmpRate(input.top1Rate, thresholds.top1Rate),
    `≥ ${Math.round(thresholds.top1Rate * 100)}%`, '需提升');
  push('avgRank', input.avgRank == null ? null : Math.round(input.avgRank * 100) / 100,
    cmpRank(input.avgRank, thresholds.avgRank), `≤ ${thresholds.avgRank}`, '需提升');
  push('sentimentScore', input.sentimentScore,
    input.sentimentScore == null ? null : input.sentimentScore >= thresholds.sentimentScore,
    `≥ ${thresholds.sentimentScore}`, '需关注');

  const ownedPass =
    input.ownedCitationShare == null || input.ownedCitationCount == null
      ? null
      : input.ownedCitationShare >= thresholds.ownedCitationShare &&
        input.ownedCitationCount >= thresholds.ownedCitationMinCount;
  push('ownedCitationShare', pct(input.ownedCitationShare), ownedPass,
    `≥ ${Math.round(thresholds.ownedCitationShare * 100)}% 且 ≥${thresholds.ownedCitationMinCount} 条`,
    '话语权薄弱');

  const judged = items.filter((i) => i.pass !== null);
  const passed = judged.filter((i) => i.pass).length;
  const failed = judged.length - passed;
  return {
    items,
    passed,
    total: judged.length,
    summary: judged.length === 0 ? '暂无数据' : `${passed} 项达标 · ${failed} 项需提升`,
  };
}
