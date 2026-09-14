import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { reports, type Db } from '@geo/db';
import { eq } from 'drizzle-orm';
import { createStorageFromEnv } from '@geo/evidence';
import { REPUTATION_QUEUE, REPORTS_QUEUE, bullConnection } from './queue';
import { extractReputation } from './reputation';
import { buildReportPayload } from './report-builder';

/** 口碑异步抽取消费器(docs/05 §1 管道②):确定性基线,生产替换 LLM。 */
export function startReputationWorker(db: Db, concurrency = 2): Worker {
  const worker = new Worker(
    REPUTATION_QUEUE,
    async (job) => {
      await extractReputation(db, job.data as { runId: number; brandId: number; answerText: string; ranAt: string });
    },
    { connection: bullConnection(), concurrency },
  );
  worker.on('error', (err) => console.error('[reputation] worker error', err));
  worker.on('failed', (job, err) => console.error(`[reputation] job=${job?.id} failed after retries:`, err));
  return worker;
}

/**
 * 报告生成消费器(docs/03 §3.6):聚合口径事实 → payload 落对象存储 → 置 done。
 * PDF 渲染(P1)在 payload 基础上加模板;周报 cron 在 main.ts 注册 repeatable job。
 */
export function startReportsWorker(db: Db, concurrency = 1): Worker {
  const storage = createStorageFromEnv();
  const worker = new Worker(
    REPORTS_QUEUE,
    async (job) => {
      const { reportId, brandId, type, period } = job.data as {
        reportId: number;
        brandId: number;
        type: string;
        period: string;
      };
      await db.update(reports).set({ status: 'generating' }).where(eq(reports.id, reportId));
      try {
        const payload = await buildReportPayload(db, brandId, type, period);
        const key = `evidence/reports/${reportId}/payload.json`;
        await storage.put(key, Buffer.from(JSON.stringify(payload, null, 2)));
        await db
          .update(reports)
          .set({
            status: 'done',
            payloadRef: key,
            sharedToken: randomUUID(),
          })
          .where(eq(reports.id, reportId));
      } catch (err) {
        await db.update(reports).set({ status: 'failed' }).where(eq(reports.id, reportId));
        throw err;
      }
    },
    { connection: bullConnection(), concurrency },
  );
  worker.on('error', (err) => console.error('[reports] worker error', err));
  worker.on('failed', (job, err) => console.error(`[reports] job=${job?.id} failed after retries:`, err));
  return worker;
}

/** 注册周报自动生成(每周一 08:00 上海时区,docs/01 §3.8)。 */
export async function scheduleWeeklyReports(): Promise<void> {
  const queue = new Queue(REPORTS_QUEUE, { connection: bullConnection() });
  await queue.add(
    'cron-weekly',
    { cronScope: 'weekly' },
    { repeat: { pattern: '0 8 * * 1', tz: 'Asia/Shanghai' }, jobId: 'cron-weekly' },
  );
  await queue.close();
}
