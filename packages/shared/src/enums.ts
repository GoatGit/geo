/**
 * 引擎与端。网页端 5 引擎起步(docs/00 §2),APP 端 P1(docs/04 §2.2)。
 */
export const WEB_ENGINES = ['doubao', 'deepseek', 'wenxin', 'qwen', 'yuanbao'] as const;
export type EngineId = (typeof WEB_ENGINES)[number];

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
export type ReportType = 'weekly' | 'monthly' | 'diagnostic';

/** 适配器采集态(QueryRun 四态的执行侧子集,docs/04 §2)。 */
export type AskStatus = 'ok_with_answer' | 'ok_empty' | 'failed';

/** 回答附带的原始引用(结构化抓取,docs/04 §2.1)。 */
export interface RawCitation {
  url: string;
  title?: string;
}

export function isWebEngine(v: string): v is EngineId {
  return (WEB_ENGINES as readonly string[]).includes(v);
}
