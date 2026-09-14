/**
 * 跨进程运行时契约:队列名与 Redis key 由 API 与 Worker 共同读写,
 * 字符串只在此定义一次,任何一侧都不得私写字面量。
 */

export const COLLECT_QUEUE = 'collect';
export const REPUTATION_QUEUE = 'extract-reputation';
export const REPORTS_QUEUE = 'reports';

export const REDIS_PROGRESS_CHANNEL = 'geo:progress';

/** Worker 调度器心跳:scheduler 每 tick 覆写,API 管理后台据此判活。 */
export const WORKER_HEARTBEAT_KEY = 'geo:worker:heartbeat';
/** 心跳判活窗口 = 3 个调度间隔(默认 60s × 3)。 */
export const WORKER_HEARTBEAT_STALE_MS = 180_000;

/** 引擎熔断位:tripped 为自动熔断(5 分钟半开),manual 为管理后台手动暂停(无过期)。 */
export const breakerTrippedKey = (engine: string) => `geo:breaker:tripped:${engine}`;
export const breakerManualKey = (engine: string) => `geo:breaker:manual:${engine}`;
