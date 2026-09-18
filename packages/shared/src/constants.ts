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

// ===== 平台配置(管理后台读写,worker 调度与 API 配额校验共同遵守;docs/03 §3.2) =====

export type AccountRole = 'user' | 'admin';

/**
 * Insight Agent 配置(docs/09):LLM 判定层。
 * apiKey 明文存储(与 proxyPool.key 同先例);admin 读取侧掩码,写入"空 = 保留原值"。
 */
export interface InsightAgentSettings {
  /** 总开关:false 时全量走规则引擎(现状行为),不发起任何 LLM 调用 */
  enabled: boolean;
  /** rules=现状;shadow=口径走规则、LLM 结果入 query_runs.meta.insightShadow 对比;llm=LLM 判定、失败回落规则 */
  mode: 'rules' | 'shadow' | 'llm';
  protocol: 'openai' | 'anthropic';
  /** https 端点(openai 兼容含 /v1 基址;anthropic 为网关基址) */
  endpoint: string;
  apiKey: string;
  model: string;
  /** 单次调用超时;API 同步路径(分类/拓写)另受 3s 上限约束 */
  timeoutMs: number;
}

export const DEFAULT_INSIGHT_AGENT_SETTINGS: InsightAgentSettings = {
  enabled: false,
  mode: 'rules',
  protocol: 'openai',
  endpoint: '',
  apiKey: '',
  model: '',
  timeoutMs: 8000,
};

/**
 * 平台级配置:管理后台的"全局旋钮"。持久化在 platform_settings(key-value),
 * 未写入的键取 DEFAULT_PLATFORM_SETTINGS —— 新增键只需扩展本接口与默认值。
 */
export interface PlatformSettings {
  /** 调度总开关(kill switch):false 时轮次调度器停止派发,在途任务不受影响 */
  schedulerEnabled: boolean;
  /** 全平台每日任务上限(QueryRun 数,自然日);0 = 不限 */
  globalDailyRunCap: number;
  /** 每引擎每日任务上限;0 或缺省 = 不限 */
  engineDailyCaps: Record<string, number>;
  /** 代理池(青果网络长效代理,docs/07 §13 闸门 #2):登录/采集共用稳定出口 IP */
  proxyPool: { enabled: boolean; key: string };
  /** Insight Agent(docs/09):LLM 判定层(识别/口碑/分类/拓写),规则引擎为降级路径 */
  insightAgent: InsightAgentSettings;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  schedulerEnabled: true,
  globalDailyRunCap: 0,
  engineDailyCaps: {},
  proxyPool: { enabled: false, key: '' },
  insightAgent: DEFAULT_INSIGHT_AGENT_SETTINGS,
};

export const PLATFORM_SETTING_KEYS = [
  'schedulerEnabled',
  'globalDailyRunCap',
  'engineDailyCaps',
  'proxyPool',
  'insightAgent',
] as const;
export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

/** 深合并存储值与默认值,并做类型与边界净化(脏数据不致命,回退默认)。 */
export function mergePlatformSettings(stored: Partial<Record<string, unknown>> | Record<string, unknown>[]): PlatformSettings {
  const byKey = new Map<string, unknown>();
  if (Array.isArray(stored)) {
    for (const row of stored as Array<{ key?: string; value?: unknown }>) {
      if (row && typeof row.key === 'string') byKey.set(row.key, row.value);
    }
  }
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  // 布尔净化必须与 num 一样严格:Boolean('false') === true,脏字符串会把 kill switch 重新打开
  const bool = (v: unknown, fallback: boolean): boolean => {
    if (v === true || v === 1 || v === 'true' || v === 'on') return true;
    if (v === false || v === 0 || v === 'false' || v === 'off') return false;
    return fallback;
  };
  const capsRaw = byKey.get('engineDailyCaps');
  const engineDailyCaps: Record<string, number> = {};
  if (capsRaw && typeof capsRaw === 'object' && !Array.isArray(capsRaw)) {
    for (const [k, v] of Object.entries(capsRaw as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) engineDailyCaps[k] = Math.floor(n);
    }
  }
  return {
    schedulerEnabled: byKey.get('schedulerEnabled') === undefined ? true : bool(byKey.get('schedulerEnabled'), true),
    globalDailyRunCap: num(byKey.get('globalDailyRunCap'), 0),
    engineDailyCaps,
    proxyPool: (() => {
      const raw = byKey.get('proxyPool');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const r = raw as { enabled?: unknown; key?: unknown };
        return { enabled: bool(r.enabled, false), key: typeof r.key === 'string' ? r.key : '' };
      }
      return { enabled: false, key: '' };
    })(),
    insightAgent: (() => {
      const raw = byKey.get('insightAgent');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_INSIGHT_AGENT_SETTINGS };
      const r = raw as Record<string, unknown>;
      // endpoint 强制 https(SSRF 面收敛,docs/09 §9);timeout 限幅 2s..30s
      const endpoint =
        typeof r.endpoint === 'string' && /^https:\/\//i.test(r.endpoint.trim()) ? r.endpoint.trim() : '';
      const timeout = num(r.timeoutMs, DEFAULT_INSIGHT_AGENT_SETTINGS.timeoutMs);
      return {
        enabled: bool(r.enabled, false),
        mode: r.mode === 'shadow' || r.mode === 'llm' ? r.mode : 'rules',
        protocol: r.protocol === 'anthropic' ? 'anthropic' : 'openai',
        endpoint,
        apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
        model: typeof r.model === 'string' ? r.model.trim() : '',
        timeoutMs: Math.min(Math.max(timeout, 2_000), 30_000),
      };
    })(),
  };
}

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
  /** 最佳位次那次采集的 runId(前端点击单元格回溯 AI 原文快照) */
  runId?: number | null;
  /** 上一窗口同引擎最好位次(环比 ▲▼;null = 上期无数据) */
  prevRank?: number | null;
  prevMentioned?: boolean | null;
}

export interface MatrixRow {
  questionId: number;
  questionText: string;
  cells: MatrixCell[];
  /** docs/02 §1.3:未上榜记 N+1 取中位数 */
  compositeRank: number | null;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | null;
  /** 行级三率(全景矩阵列;分母 = 实际参采引擎数) */
  mentionRate: number | null;
  top3Rate: number | null;
  top1Rate: number | null;
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

/** 套餐定价(docs/02 §7.1),单位:分;年付 = 月付 × 10(享约 17% 折扣)。 */
export const PLAN_PRICING: Record<Exclude<PlanTier, 'free' | 'custom'>, { monthly: number; yearly: number }> = {
  starter: { monthly: 7900, yearly: 79000 },
  standard: { monthly: 19900, yearly: 199000 },
  pro: { monthly: 49900, yearly: 499000 },
};

/** 可购买的付费档位(免费版无需支付,定制走商务)。 */
export const PURCHASABLE_PLANS = ['starter', 'standard', 'pro'] as const;

/** 积分单价(docs/02 §7.2):¥0.1/积分,充值 100 积分起。 */
export const CREDIT_UNIT_PRICE_FEN = 10; // 分/积分
