'use client';

import { useSyncExternalStore } from 'react';
import { api, brandStore } from './api';

export { api, brandStore };

/** 通用查询 hooks:统一带 brandId。 */
import { useQuery } from '@tanstack/react-query';

/** 响应式读取当前品牌:订阅 brandStore,切换品牌后依赖它的查询自动换 key 重取(免整页刷新)。 */
export function useBrandId(): number | null {
  return useSyncExternalStore(
    brandStore.subscribe,
    () => brandStore.get(),
    // SSR/水合期无 localStorage,以 null 起步,水合后再读到真实值
    () => null,
  );
}

export interface RankingsDto {
  /** 所选窗口无数据时自动回落到更大窗口(旧数据保留展示);仅回落时存在 */
  fallback?: { requestedDays: number; actualDays: number; quotaBlocked: number; failed: number };
  /** 问题层→转化结局(单品牌桑基):每层问题的提问/提及/Top3/首推/缺席次数 */
  layerSankey?: Array<{ layer: string; asked: number; mentioned: number; top3: number; top1: number; missed: number }>;
  /** 本品 vs 行业均值(行业=品牌所属行业的全部监测品牌;只出均值) */
  benchmark?: {
    industry: string | null;
    mentionRate: number | null;
    top3Rate: number | null;
    top1Rate: number | null;
    brandCount: number;
    selfMentionRate: number | null;
  };
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
    cells: Array<{
      engine: string;
      mentioned: boolean;
      rank: number | null;
      runId?: number | null;
      prevRank?: number | null;
      prevMentioned?: boolean | null;
      /** 单元格数据采集时间(ISO);回填单元格=最近一次有效 run 时间 */
      asOf?: string | null;
      /** true=窗口内无采集,来自最近一次有效 run 回填(展示"N 天前") */
      stale?: boolean;
    }>;
  }>;
  engineStats: Array<{ engine: string; mentionRate: number | null; top3Rate: number | null; top1Rate: number | null; denominatorNote?: string }>;
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

