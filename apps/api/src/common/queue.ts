import { loadEnv } from '../config/env';

/**
 * BullMQ 连接统一收口:显式走 loadEnv().redisUrl。
 * 禁止 `process.env.REDIS_URL ?? 'redis://localhost:6379'` 式旁路——fallback 字符串
 * 会把配置错误掩盖成"连上错的 Redis",高并发下每次建队还重复建连。
 */
export function bullConnection() {
  return { url: loadEnv().redisUrl, maxRetriesPerRequest: null };
}
