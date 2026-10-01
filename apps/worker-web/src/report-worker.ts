import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { reports, type Db } from '@geo/db';
import { eq, sql } from 'drizzle-orm';
import { PLAN_LIMITS, type PlanTier } from '@geo/shared';
import { createStorageFromEnv } from '@geo/evidence';
import { REPUTATION_QUEUE, REPORTS_QUEUE, bullConnection } from './queue';
import { extractReputation } from './reputation';
import { rebuildReputation } from './reputation-rebuild';
import { buildReportPayload } from './report-builder';

/** 口碑异步抽取消费器(docs/05 §1 管道②):判定层 = Insight Agent(docs/09 §6),redis 供调用统计。 */
export function startReputationWorker(db: Db, redis?: Redis | null, concurrency = 2): Worker {
  const worker = new Worker(
    REPUTATION_QUEUE,
    async (job) => {
      if ((job.name ?? '') === 'rebuild') {
        await rebuildReputation(db, Math.min(Math.max(Number(job.data?.days) || 7, 1), 90), redis ?? null);
        return;
      }
      await extractReputation(
        db,
        job.data as { runId: number; brandId: number; answerText: string; ranAt: string },
        redis,
      );
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
 * REPORTS_QUEUE 必须只有这一个消费者:job 由 BullMQ 投递给恰好一个 consumer,
 * 历史上曾用第二个 consumer 处理 cron fan-out,双方互相"过滤"对方的名字导致
 * cron-weekly 被生成器吃掉(当周周报全丢)/ generate 被过滤器静默完成(报告卡 generating)。
 */
export function startReportsWorker(db: Db, concurrency = 1): Worker {
  const storage = createStorageFromEnv();
  const fanoutQueue = new Queue(REPORTS_QUEUE, { connection: bullConnection() });
  const worker = new Worker(
    REPORTS_QUEUE,
    async (job) => {
      if (job.name === 'cron-weekly') {
        await runWeeklyReportFanout(db, fanoutQueue);
        return;
      }
      if (job.name !== 'generate') {
        // 未知名字显式失败:静默 return 会被 BullMQ 记为 completed,任务凭空消失
        throw new Error(`[reports] unexpected job name: ${job.name}`);
      }
      const { reportId, brandId, type, period } = job.data as {
        reportId: number;
        brandId: number;
        type: string;
        period: string;
      };
      if (!reportId) throw new Error(`[reports] generate job missing reportId: ${JSON.stringify(job.data)}`);
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
  const origClose = worker.close.bind(worker);
  worker.close = async () => {
    await fanoutQueue.close();
    return origClose();
  };
  return worker;
}

/**
 * cron-weekly fan-out:给每个活跃订阅品牌建周报行并入队 generate。
 * 同一品牌同一周期幂等(not exists 非 failed 报告),failed 除外可重生成;
 * 只给未过期订阅的品牌入队:订阅行无自动到期降档,status 停在 active 不可信;
 * 档位是否含周报由 PLAN_LIMITS.weeklyReport 判定(与用户侧生成入口同口径)。
 */
export async function runWeeklyReportFanout(db: Db, queue: Queue): Promise<void> {
  const res = await db.execute(sql`
    select cp.brand_id::bigint as brand_id, s.plan as plan, to_char(now(), 'IYYY-MM-DD') as period
    from collection_plans cp
    join subscriptions s on s.brand_id = cp.brand_id
    where cp.active
      and s.status = 'active'
      and s.account_id is not null
      and (s.period_end is null or s.period_end > now())
      and not exists (
        select 1 from reports r
        where r.brand_id = cp.brand_id and r.type = 'weekly'
          and r.period = to_char(now(), 'IYYY-MM-DD')
          and r.status <> 'failed'
      )
  `);
  const rows = (res as unknown as { rows: Array<{ brand_id: string; plan: string; period: string }> }).rows;
  for (const r of rows) {
    if (!PLAN_LIMITS[r.plan as PlanTier]?.weeklyReport) continue;
    const brandId = Number(r.brand_id);
    const inserted = (
      await db
        .insert(reports)
        .values({ brandId, type: 'weekly', period: r.period })
        .returning({ id: reports.id })
    )[0]!;
    await queue.add(
      'generate',
      { reportId: inserted.id, brandId, type: 'weekly', period: r.period },
      { attempts: 3, removeOnComplete: 100 },
    );
  }
}

/** 注册周报自动生成(每周一 08:00 上海时区,docs/01 §3.8)。 */
export async function scheduleWeeklyReports(): Promise<void> {
  const queue = new Queue(REPORTS_QUEUE, { connection: bullConnection() });
  await queue.add(
    'cron-weekly',
    { cronScope: 'weekly' },
    { repeat: { pattern: '0 8 * * 1', tz: 'Asia/Shanghai' }, jobId: 'cron-weekly', attempts: 3 },
  );
  await queue.close();
}
