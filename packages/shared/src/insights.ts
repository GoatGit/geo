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
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  total: number;
  unit?: string;
  items: Array<{
    name: string;
    value: number;
    group?: 'domestic' | 'intl' | 'highlight' | 'normal';
    /** 该条目的样本量(有效回答数);读者据此判断比率可信度 */
    n?: number;
    /** 较上期变动(百分点或绝对数,正=上升);首期报告无此字段 */
    delta?: number;
  }>;
}

/** AI 筛选漏斗:每层 count,pct 相对首层自动计算 */
export interface FunnelBlock {
  type: 'funnel';
  title: string;
  note?: string;
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  stages: Array<{ label: string; note: string; count: number }>;
}

/** 品牌 × 维度命中热力图:cells 为 0-1 命中率,null = 该列无有效样本(渲染为空白) */
export interface HeatmapBlock {
  type: 'heatmap';
  title: string;
  note?: string;
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  columns: string[];
  rows: Array<{ name: string; cells: Array<number | null> }>;
}

/** 多品牌维度形状对比(雷达):values 为 0-1 */
export interface RadarBlock {
  type: 'radar';
  title: string;
  note?: string;
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  axes: string[];
  series: Array<{ name: string; values: number[] }>;
}

/** 每日趋势(折线):points 按时间升序,value=null 表示当日无有效样本(断线) */
export interface TrendBlock {
  type: 'trend';
  title: string;
  note?: string;
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  /** 值域提示:'%' 时坐标轴按 0-100 处理,否则按数据范围自适应 */
  unit?: string;
  points: Array<{ label: string; value: number | null }>;
}

/** 双维度散点(可带对角参考线与气泡大小):x/y 为 0-1 命中率 */
export interface ScatterBlock {
  type: 'scatter';
  title: string;
  note?: string;
  /** 图表上方的一句话结论(数据驱动的「所以呢」),由组稿器生成 */
  summary?: string;
  xLabel: string;
  yLabel: string;
  diagonal?: boolean;
  points: Array<{ name: string; x: number; y: number; size?: number; group?: string; note?: string }>;
  /** 分组图例:group 值 → 显示名 */
  groups?: Array<{ key: string; label: string; color?: 'brand' | 'gray' | 'accent' }>;
}

export type InsightBlock =
  | TakeawayBlock
  | BarRankBlock
  | FunnelBlock
  | HeatmapBlock
  | RadarBlock
  | TrendBlock
  | ScatterBlock;

export const INSIGHT_BLOCK_TYPES = [
  'takeaway',
  'barRank',
  'funnel',
  'heatmap',
  'radar',
  'trend',
  'scatter',
] as const;

/** 报告封面指标(列表卡与详情页页眉)。 */
export interface InsightCover {
  headline?: string;
  brands?: number;
  questions?: number;
  answers?: number;
  testedAt?: string;
}

/** 「运行」数据聚合状态(0005):idle=就绪 running=聚合中 failed=失败。 */
export type InsightBuildStatus = 'idle' | 'running' | 'failed';

export interface InsightSummaryDto {
  id: number;
  industry: string;
  issue: string;
  title: string;
  summary: string;
  cover: InsightCover;
  featured: boolean;
  publishedAt: string | null;
  buildStatus?: InsightBuildStatus;
  builtAt?: string | null;
  windowDays?: number | null;
}

export interface InsightDetailDto extends InsightSummaryDto {
  blocks: InsightBlock[];
}

/** 运行参数:聚合窗口天数候选(管理后台「运行」选择)。 */
export const INSIGHT_WINDOW_CHOICES = [7, 30, 90] as const;

/** 行业档位分类(用于覆盖 PLAN_LIMITS 之外的行业维度,预留)。 */
export type InsightPlanGate = PlanTier;
