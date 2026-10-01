// 队列名与 Redis key 是 API/Worker 共同契约,定义在 @geo/shared(单一事实源)
export {
  COLLECT_QUEUE,
  REPUTATION_QUEUE,
  REPORTS_QUEUE,
  INSIGHTS_QUEUE,
  REDIS_PROGRESS_CHANNEL,
} from '@geo/shared';

export interface CollectJobData {
  runId: number;
  brandId: number;
  accountId: number;
  roundId: number;
  questionId: number;
  questionType: 'ranking' | 'reputation';
  questionText: string;
  engine: string;
  surface: 'web';
  /** 队列优先级:docs/04 §5 快速体检 > 专业 > 标准 > 入门 > 免费 */
  priority: number;
  /** 延迟重排次数(熔断/账号池耗尽);超过 MAX_DEFERRED 落 quota_blocked 收口,防无限自我复制 */
  deferredCount?: number;
  /** 首次入队时间(ms):延迟重排会新建 job 重置 timestamp,透传原始值保住"超 2 小时僵尸"判定 */
  firstQueuedAt?: number;
}

export interface ReputationJobData {
  runId: number;
  brandId: number;
  answerText: string;
  /** 提问原文:证据摘要需剔除"回答以问题回显开头"的句子(元宝实测) */
  questionText?: string;
  ranAt: string;
}

export function bullConnection() {
  return { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null };
}

export function priorityOf(plan: string): number {
  // BullMQ: 数值越小越优先(1 最高);docs/04 §5 快速体检 > 专业 > 标准 > 入门 > 免费
  switch (plan) {
    case 'custom':
      return 10;
    case 'pro':
      return 20;
    case 'standard':
      return 30;
    case 'starter':
      return 40;
    default:
      return 50;
  }
}
