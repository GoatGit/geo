import type { PlanTier } from './enums';

/**
 * 行业洞察内容块(docs/01 §3.10 扩展):管理员后台以 JSON 配置,
 * 前端按类型用内联 SVG 渲染(印刷风,零图表依赖)。口径单一事实源在此。
 */

export interface TakeawayBlock {
  type: 'takeaway';
  title: string;
  text: string;
  tone?: 'brand' | 'warn' | 'good';
}

/** 品牌命中排行(横向条形):value 相对 total(如 50/78)或百分比(total=100 + unit='%') */
export interface BarRankBlock {
  type: 'barRank';
  title: string;
  note?: string;
  total: number;
  unit?: string;
  items: Array<{ name: string; value: number; group?: 'domestic' | 'intl' | 'highlight' | 'normal' }>;
}

/** AI 筛选漏斗:每层 count,pct 相对首层自动计算 */
export interface FunnelBlock {
  type: 'funnel';
  title: string;
  note?: string;
  stages: Array<{ label: string; note: string; count: number }>;
}

/** 品牌 × 维度命中热力图:cells 为 0-1 命中率 */
export interface HeatmapBlock {
  type: 'heatmap';
  title: string;
  note?: string;
  columns: string[];
  rows: Array<{ name: string; cells: number[] }>;
}

/** 多品牌维度形状对比(雷达):values 为 0-1 */
export interface RadarBlock {
  type: 'radar';
  title: string;
  note?: string;
  axes: string[];
  series: Array<{ name: string; values: number[] }>;
}

/** 双维度散点(可带对角参考线与气泡大小):x/y 为 0-1 命中率 */
export interface ScatterBlock {
  type: 'scatter';
  title: string;
  note?: string;
  xLabel: string;
  yLabel: string;
  diagonal?: boolean;
  points: Array<{ name: string; x: number; y: number; size?: number; group?: string; note?: string }>;
  /** 分组图例:group 值 → 显示名 */
  groups?: Array<{ key: string; label: string; color?: 'brand' | 'gray' | 'accent' }>;
}

export type InsightBlock = TakeawayBlock | BarRankBlock | FunnelBlock | HeatmapBlock | RadarBlock | ScatterBlock;

export const INSIGHT_BLOCK_TYPES = ['takeaway', 'barRank', 'funnel', 'heatmap', 'radar', 'scatter'] as const;

/** 报告封面指标(列表卡与详情页页眉)。 */
export interface InsightCover {
  headline?: string;
  brands?: number;
  questions?: number;
  answers?: number;
  testedAt?: string;
}

export interface InsightSummaryDto {
  id: number;
  industry: string;
  issue: string;
  title: string;
  summary: string;
  cover: InsightCover;
  featured: boolean;
  publishedAt: string | null;
}

export interface InsightDetailDto extends InsightSummaryDto {
  blocks: InsightBlock[];
}

/** 行业档位分类(用于覆盖 PLAN_LIMITS 之外的行业维度,预留)。 */
export type InsightPlanGate = PlanTier;
