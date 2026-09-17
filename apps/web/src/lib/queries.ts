'use client';

import { api, brandStore } from './api';

export { api, brandStore };

/** 通用查询 hooks:统一带 brandId。 */
import { useQuery } from '@tanstack/react-query';

export function useBrandId(): number | null {
  return brandStore.get();
}

export interface RankingsDto {
  cards: Array<{
    metric: string;
    value: number | null;
    numerator: number | null;
    denominator: number | null;
    excludedFailed: number;
    excludedQuotaBlocked: number;
    asOf: string;
    source: string;
  }>;
  funnel: Array<{ key: string; label: string; numerator: number; denominator: number; rate: number | null; denominatorNote: string }>;
  matrix: Array<{
    questionId: number;
    questionText: string;
    compositeRank: number | null;
    layer: string | null;
    mentionRate: number | null;
    top3Rate: number | null;
    top1Rate: number | null;
    cells: Array<{ engine: string; mentioned: boolean; rank: number | null; runId?: number | null; prevRank?: number | null; prevMentioned?: boolean | null }>;
  }>;
  engineStats: Array<{ engine: string; mentionRate: number; top3Rate: number; top1Rate: number }>;
  trend: Array<{ date: string; mentionRate: number | null; top3Rate: number | null; top1Rate: number | null }>;
  health: {
    summary: string;
    items: Array<{ metric: string; value: number | null; pass: boolean | null; label: string }>;
  };
  excluded: { failed: number; quotaBlocked: number };
  asOf: string;
  source: string;
}

export function useRankings(days: number) {
  const brandId = useBrandId();
  return useQuery({
    queryKey: ['rankings', brandId, days],
    queryFn: () => api<RankingsDto>(`/monitor/rankings?brand=${brandId}&days=${days}`),
    enabled: !!brandId,
  });
}

