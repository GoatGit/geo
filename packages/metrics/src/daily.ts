import { countsTowardsDenominator, type QueryRunStatus } from '@geo/shared';

/** 单条 QueryRun 的聚合输入(一次抽取后的最小事实)。 */
export interface RunFact {
  status: QueryRunStatus;
  engine: string;
  mentioned: boolean;
  rank: number | null;
  compositeRank?: number | null;
}

export interface DailyAggregate {
  valid: number;
  excludedFailed: number;
  excludedQuotaBlocked: number;
  mentioned: number;
  top3: number;
  top1: number;
  mentionRate: number | null;
  top3Rate: number | null;
  top1Rate: number | null;
  /** 有名次 QueryRun 的位次均值(docs/02 §2),越小越好 */
  avgRank: number | null;
  /** 02 §1.3 综合名次的趋势均值(日结) */
  avgCompositeRank: number | null;
}

/**
 * 品牌级日聚合(docs/02 §2):
 * 分母 = ok_with_answer + ok_empty;Top3/首推率分母 = 有效且有名次。
 */
export function aggregateDaily(facts: RunFact[]): DailyAggregate {
  let valid = 0;
  let excludedFailed = 0;
  let excludedQuotaBlocked = 0;
  let mentioned = 0;
  let top3 = 0;
  let top1 = 0;
  let rankSum = 0;
  let rankCount = 0;
  const composites: number[] = [];

  for (const f of facts) {
    if (f.status === 'failed') {
      excludedFailed += 1;
      continue;
    }
    if (f.status === 'quota_blocked') {
      excludedQuotaBlocked += 1;
      continue;
    }
    if (!countsTowardsDenominator(f.status)) continue;
    valid += 1;
    if (f.mentioned) {
      mentioned += 1;
      if (f.rank !== null) {
        rankSum += f.rank;
        rankCount += 1;
        if (f.rank <= 3) {
          top3 += 1;
          if (f.rank === 1) top1 += 1;
        }
      }
    }
    if (f.compositeRank != null) composites.push(f.compositeRank);
  }

  const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
  return {
    valid,
    excludedFailed,
    excludedQuotaBlocked,
    mentioned,
    top3,
    top1,
    mentionRate: rate(mentioned, valid),
    top3Rate: rate(top3, rankCount),
    top1Rate: rate(top1, rankCount),
    avgRank: rankCount > 0 ? Math.round((rankSum / rankCount) * 100) / 100 : null,
    avgCompositeRank:
      composites.length > 0
        ? Math.round((composites.reduce((a, b) => a + b, 0) / composites.length) * 10) / 10
        : null,
  };
}
