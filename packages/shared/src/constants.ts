import type { EngineId, PlanTier, QueryRunStatus, Surface, SubjectKind } from './enums';

/** 健康阈值(docs/02 §3)。初始值与行业水位对齐;方法论 = 行业 P75 分位,每 8 周重校。 */
export interface HealthThresholds {
  mentionRate: number; // 达标线(0-1)
  top3Rate: number;
  top1Rate: number;
  avgRank: number; // ≤ 达标线
  sentimentScore: number; // 0-100
  ownedCitationShare: number; // 自有信源引用占比 ≥ 8% 且 ≥ minCount 条
  ownedCitationMinCount: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  mentionRate: 0.85,
  top3Rate: 0.6,
  top1Rate: 0.6,
  avgRank: 2.0,
  sentimentScore: 60,
  ownedCitationShare: 0.08,
  ownedCitationMinCount: 10,
};

/** 行动清单规则集版本(docs/02 §6):版本号入库,报告可复现。 */
export const RULESET_VERSION = '2026.09.1';

/** 抽取器版本(docs/05 §1):解析升级后可对历史证据包全量重放。 */
export const PARSER_VERSION = 'v1';

/** 快照保留(docs/01 §3.7):录屏/截图 7 天,到期前 3 天提示导出。 */
export const SNAPSHOT_RETENTION_DAYS = 7;

/** 体检标签阈值"校准中"宽限期(灰度 8 周,docs/02 §3)。 */
export const THRESHOLD_CALIBRATION_GRACE_DAYS = 56;

export interface PlanLimits {
  rankingQuota: number;
  reputationQuota: number;
  webEngines: number;
  appEngines: number;
  historyDays: number;
  weeklyReport: boolean;
  monthlyReport: boolean;
  exportAllowed: boolean;
  multiBrand: number;
  apiAccess: boolean;
}

/** 套餐门控(docs/01 §3.10 功能门控矩阵;定价 docs/02 §7.1)。 */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    rankingQuota: 3,
    reputationQuota: 1,
    webEngines: 3,
    appEngines: 0,
    historyDays: 7,
    weeklyReport: false,
    monthlyReport: false,
    exportAllowed: false,
    multiBrand: 1,
    apiAccess: false,
  },
  starter: {
    rankingQuota: 8,
    reputationQuota: 2,
    webEngines: 5,
    appEngines: 0,
    historyDays: 30,
    weeklyReport: true,
    monthlyReport: false,
    exportAllowed: true,
    multiBrand: 1,
    apiAccess: false,
  },
  standard: {
    rankingQuota: 30,
    reputationQuota: 8,
    webEngines: 5,
    appEngines: 2,
    historyDays: 90,
    weeklyReport: true,
    monthlyReport: true,
    exportAllowed: true,
    multiBrand: 1,
    apiAccess: false,
  },
  pro: {
    rankingQuota: 100,
    reputationQuota: 30,
    webEngines: 5,
    appEngines: 2,
    historyDays: 180,
    weeklyReport: true,
    monthlyReport: true,
    exportAllowed: true,
    multiBrand: 5,
    apiAccess: false,
  },
  custom: {
    rankingQuota: Number.MAX_SAFE_INTEGER,
    reputationQuota: Number.MAX_SAFE_INTEGER,
    webEngines: 5,
    appEngines: 3,
    historyDays: 365,
    weeklyReport: true,
    monthlyReport: true,
    exportAllowed: true,
    multiBrand: Number.MAX_SAFE_INTEGER,
    apiAccess: true,
  },
};

export const PLAN_LABELS: Record<PlanTier, string> = {
  free: '免费版',
  starter: '入门',
  standard: '标准',
  pro: '专业',
  custom: '定制',
};

/** 积分定价(docs/02 §7.2):¥0.1/积分。 */
export const CREDIT_FEN_PER_UNIT = 10; // 1 积分 = 10 分 = ¥0.1
export const CREDIT_COSTS = {
  diagnosticWebQuery: 2,
  diagnosticAppQuery: 4,
  diagnosticAppQueryPremium: 8,
  historyExport: 10,
  reportPdfExpress: 20,
} as const;

// ===== 指标 DTO(docs/05 §6 约定:所有指标响应携带分母/excluded/asOf/source) =====

export type MetricSource = 'realtime' | 'daily';

export interface MetricCard {
  metric:
    | 'mentionRate'
    | 'top3Rate'
    | 'top1Rate'
    | 'avgRank'
    | 'sentimentScore'
    | 'ownedCitationShare';
  /** 已归一到 0-1 的率(或 0-100 的分、名次均值);avgRank 越小越好 */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  /** docs/02 §1.1:failed/quota_blocked 计数必须可见,不允许静默为 0 */
  excludedFailed: number;
  excludedQuotaBlocked: number;
  asOf: string;
  source: MetricSource;
}

export interface FunnelStage {
  key: 'mention' | 'top3' | 'top1';
  label: string;
  numerator: number;
  denominator: number;
  rate: number | null;
  /** 上一段转化率口径的分母说明(docs/02 §2 嵌套转化) */
  denominatorNote: string;
}

export interface MatrixCell {
  engine: EngineId;
  surface: Surface;
  status: QueryRunStatus | 'not_collected';
  mentioned: boolean;
  /** 有序列表位次;散文提及为 null */
  rank: number | null;
}

export interface MatrixRow {
  questionId: number;
  questionText: string;
  cells: MatrixCell[];
  /** docs/02 §1.3:未上榜记 N+1 取中位数 */
  compositeRank: number | null;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | null;
}

export interface RecognitionEntry {
  id?: number;
  kind: SubjectKind;
  name: string;
  aliases: string[];
  note?: string;
  confirmed: boolean;
}

export interface RecognitionProfile {
  self: RecognitionEntry;
  competitors: RecognitionEntry[];
}

export interface ActionItem {
  priority: 'P0' | 'P1' | 'P2';
  ruleId: string;
  action: string;
  dataBasis: string;
  target: string;
}

export interface EvidencePointer {
  hitWord: string;
  snippet: string;
  /** 在原文中的位置:列表项序号或字符偏移 */
  position: number;
}

export interface MentionFactDraft {
  runId: string;
  brandId: number;
  subjectKind: SubjectKind;
  subjectKey: string;
  subjectName: string;
  mentioned: boolean;
  rank: number | null;
  coRanked: boolean;
  evidence: EvidencePointer | null;
  parserVersion: string;
  confidence: number;
}
