import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb, ensurePartitions, reports } from '@geo/db';
import { REPORTS_QUEUE, REPUTATION_QUEUE, bullConnection } from './queue';
import { CollectProcessor } from './processor';
import { RoundScheduler } from './scheduler';
import { startReportsWorker, startReputationWorker, scheduleWeeklyReports } from './report-worker';

/**
 * Worker 启动(docs/07 §3):
 * 分区预建(幂等)→ 调度器(轮次触发)→ 采集 Worker 池 → 口碑/报告消费器 → 优雅退出。
 * 迁移在生产由发布流水线执行(db:migrate),此处仅保障分区存在。
 */
async function bootstrap() {
  const { pool, db } = createDb(process.env.DATABASE_URL ?? 'postgres://geo:geo_dev@localhost:5432/geo');
  const logger = console;

  await ensurePartitions(pool, 2);

  const scheduler = new RoundScheduler(db);
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
  scheduler.start(undefined, concurrency); // 间隔经 SCHEDULER_INTERVAL_MS 配置(默认 60s);并发数随心跳上报

  const collect = new CollectProcessor(db, new Redis(bullConnection().url, { maxRetriesPerRequest: 3 }));
  const collectWorker = collect.start(concurrency);

  const reputationWorker = startReputationWorker(db);
  const reportsWorker = startReportsWorker(db);
  await scheduleWeeklyReports();

  // 周报 cron 触发时,给每个活跃品牌入队报告(由 repeatable job 携带标记)
  const cronQueue = new Queue(REPORTS_QUEUE, { connection: bullConnection() });
  const cronConsumer = new Worker(
    REPORTS_QUEUE,
    async (job) => {
      if (job.name !== 'cron-weekly') return;
      const rows = await db.execute(sql`
        select cp.brand_id, s.account_id, 'weekly' as type,
               to_char(now(), 'IYYY-MM-DD') as period
        from collection_plans cp
        join brands b on b.id = cp.brand_id
        left join subscriptions s on s.brand_id = cp.brand_id
        where cp.active
      `);
      for (const r of cronConsumer_parse(rows)) {
        const inserted = (
          await db
            .insert(reports)
            .values({ brandId: r.brandId, type: 'weekly', period: r.period })
            .returning({ id: reports.id })
        )[0]!;
        await cronQueue.add(
          'generate',
          { reportId: inserted.id, brandId: r.brandId, type: 'weekly', period: r.period },
          { attempts: 3 },
        );
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  logger.log(
    `[worker-web] started: concurrency=${concurrency}, queues=[collect,${REPUTATION_QUEUE},${REPORTS_QUEUE}]`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`[worker-web] received ${signal}, draining...`);
    scheduler.stop();
    await Promise.allSettled([
      collectWorker.close(),
      reputationWorker.close(),
      reportsWorker.close(),
      cronConsumer.close(),
      cronQueue.close(),
    ]);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function cronConsumer_parse(rows: unknown): Array<{ brandId: number; period: string }> {
  const res = rows as { rows: Array<{ brand_id: string; period: string }> };
  return res.rows.map((r) => ({ brandId: Number(r.brand_id), period: r.period }));
}

void bootstrap();
