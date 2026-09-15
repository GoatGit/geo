import { Worker } from 'bullmq';
import type { Db } from '@geo/db';
import { INSIGHTS_QUEUE, bullConnection } from './queue';
import { runInsightBuild, type InsightBuildJob } from './insight-builder';

/**
 * 行业洞察聚合消费器(docs/01 §3.10「运行」):
 * API 管理后台入队 {insightId, windowDays} → 取数+组稿 → 回写 blocks 与 build 状态。
 * 单并发即可:聚合是重查询,串行避免挤占采集库连接。
 */
export function startInsightsWorker(db: Db, concurrency = 1): Worker<InsightBuildJob> {
  const worker = new Worker<InsightBuildJob>(
    INSIGHTS_QUEUE,
    async (job) => {
      await runInsightBuild(db, job.data);
    },
    { connection: bullConnection(), concurrency },
  );
  worker.on('error', (err) => console.error('[insights] worker error', err));
  worker.on('failed', (job, err) => console.error(`[insights] job=${job?.id} failed:`, err.message));
  return worker;
}
