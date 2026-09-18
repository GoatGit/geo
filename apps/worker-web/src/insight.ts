import type { Redis } from 'ioredis';
import { insightStatKey, type InsightAgentSettings, type InsightStatEvent } from '@geo/shared';
import { InsightAgent } from '@geo/insight-agent';

const STAT_TTL_SEC = 48 * 3600;

/** Insight Agent 日窗计数(docs/09 §10):统计失败不致命,静默吞掉。 */
export async function incrInsightStat(redis: Redis | null | undefined, event: InsightStatEvent): Promise<void> {
  if (!redis) return;
  try {
    const key = insightStatKey(event);
    await redis.incr(key);
    await redis.expire(key, STAT_TTL_SEC);
  } catch {
    /* 统计不致命 */
  }
}

/**
 * 装配 InsightAgent(docs/09 §3):事件 → Redis 计数器 + 降级日志。
 * fallback 事件 = LLM 不可用,调用方回落规则;此处只记录,不改变判定流。
 */
export function createInsightAgent(settings: InsightAgentSettings, redis: Redis | null | undefined): InsightAgent {
  return new InsightAgent({
    settings,
    onEvent: (e) => {
      if (e.kind === 'call') void incrInsightStat(redis, 'calls');
      else if (e.kind === 'fallback') {
        void incrInsightStat(redis, 'fallback');
        console.error(`[insight] ${e.task} 降级规则(.llm 失败自动回落): ${e.error ?? 'unknown'}`);
      } else if (e.kind === 'invalid_partial') {
        void incrInsightStat(redis, 'invalid_partial');
        console.warn(`[insight] ${e.task} 部分输出非法已丢弃: ${e.error ?? ''}`);
      }
    },
  });
}
