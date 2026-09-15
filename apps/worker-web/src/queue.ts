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
}

export interface ReputationJobData {
  runId: number;
  brandId: number;
  answerText: string;
  ranAt: string;
}

export function bullConnection() {
  return { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null };
}

export function priorityOf(plan: string): number {
  // BullMQ: 数值越大越优先
  switch (plan) {
    case 'pro':
      return 40;
    case 'standard':
      return 30;
    case 'custom':
      return 50;
    case 'starter':
      return 20;
    default:
      return 10;
  }
}
