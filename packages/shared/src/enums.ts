/**
 * 引擎与端。网页端 5 引擎起步(docs/00 §2),APP 端 P1(docs/04 §2.2)。
 */
export const WEB_ENGINES = ['doubao', 'deepseek', 'wenxin', 'qwen', 'yuanbao'] as const;
export type EngineId = (typeof WEB_ENGINES)[number];

/** 引擎展示名(UI 一律中文;底层数据/接口仍用 engine id,未知 id 原样回退)。 */
export const ENGINE_LABELS: Record<EngineId | string, string> = {
  doubao: '豆包',
  deepseek: 'DeepSeek',
  wenxin: '文心',
  qwen: '千问',
  yuanbao: '元宝',
};
export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

export type Surface = 'web' | 'app';

/** QueryRun 四态状态机(docs/02 §1.1):分母只计前两态,失败/拦截永不静默为 0。 */
export const QUERY_RUN_STATUSES = [
  'ok_with_answer',
  'ok_empty',
  'failed',
  'quota_blocked',
] as const;
export type QueryRunStatus = (typeof QUERY_RUN_STATUSES)[number];

export function countsTowardsDenominator(status: QueryRunStatus): boolean {
  return status === 'ok_with_answer' || status === 'ok_empty';
}

export type QuestionType = 'ranking' | 'reputation';
export type SubjectKind = 'self' | 'competitor' | 'discovered';
export type Sentiment = 'pos' | 'neu' | 'neg';
export type PlanTier = 'free' | 'starter' | 'standard' | 'pro' | 'custom';
/** 适配器采集态(QueryRun 四态的执行侧子集,docs/04 §2)。 */
export type AskStatus = 'ok_with_answer' | 'ok_empty' | 'failed';

export const REPORT_TYPES = ['weekly', 'monthly', 'diagnostic'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** 回答附带的原始引用(结构化抓取,docs/04 §2.1)。 */
export interface RawCitation {
  url: string;
  title?: string;
}

export function isWebEngine(v: string): v is EngineId {
  return (WEB_ENGINES as readonly string[]).includes(v);
}

/** 支付渠道:mock 为 dev 降级通道(密钥未配置时),生产禁用。 */
export const PAY_CHANNELS = ['wechat', 'alipay', 'mock'] as const;
export type PayChannel = (typeof PAY_CHANNELS)[number];

/** 订阅计费周期:年付 = 10 个月价(年付享折扣,落地页口径)。 */
export const BILLING_PERIODS = ['monthly', 'yearly'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** 订单状态机:created → paid;failed/refunded/expired 为终止态,已支付行不可变更。 */
export const ORDER_STATUSES = ['created', 'paid', 'failed', 'refunded', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
