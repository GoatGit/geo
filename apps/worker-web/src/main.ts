import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb, ensurePartitions, reports } from '@geo/db';
import { REPORTS_QUEUE, REPUTATION_QUEUE, bullConnection } from './queue';
import { envInt } from './config';
import { CollectProcessor } from './processor';
import { LoginManager } from './login-manager';
import { RoundScheduler } from './scheduler';
import { startReportsWorker, startReputationWorker, scheduleWeeklyReports } from './report-worker';
import { createBrokerFromEnv } from '@geo/browser-session';

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
  const concurrency = envInt('WORKER_CONCURRENCY', 4, 1, 64);
  scheduler.start(undefined, concurrency); // 间隔经 SCHEDULER_INTERVAL_MS 配置(默认 60s);并发数随心跳上报

  // 全进程共享一个 broker:采集与人工登录(refcount 复用本地浏览器进程/登录态)
  const broker = createBrokerFromEnv();
  const collect = new CollectProcessor(db, new Redis(bullConnection().url, { maxRetriesPerRequest: 3 }), broker);
  const collectWorker = collect.start(concurrency);

  const loginRedis = new Redis(bullConnection().url, { maxRetriesPerRequest: null });
  const loginManager = new LoginManager(db, loginRedis, broker);
  loginManager.start();

  const reputationWorker = startReputationWorker(db);
  const reportsWorker = startReportsWorker(db);
  await scheduleWeeklyReports();

  // 周报 cron 触发时,给每个活跃品牌入队报告;同一品牌同一周期幂等(failed 除外,可重生成)
  const cronQueue = new Queue(REPORTS_QUEUE, { connection: bullConnection() });
  const cronConsumer = new Worker(
    REPORTS_QUEUE,
    async (job) => {
      if (job.name !== 'cron-weekly') return;
      const res = await db.execute(sql`
        select cp.brand_id::bigint as brand_id, to_char(now(), 'IYYY-MM-DD') as period
        from collection_plans cp
        where cp.active
          and not exists (
            select 1 from reports r
            where r.brand_id = cp.brand_id and r.type = 'weekly'
              and r.period = to_char(now(), 'IYYY-MM-DD')
              and r.status <> 'failed'
          )
      `);
      const rows = (res as unknown as { rows: Array<{ brand_id: string; period: string }> }).rows;
      for (const r of rows) {
        const brandId = Number(r.brand_id);
        const inserted = (
          await db
            .insert(reports)
            .values({ brandId, type: 'weekly', period: r.period })
            .returning({ id: reports.id })
        )[0]!;
        await cronQueue.add(
          'generate',
          { reportId: inserted.id, brandId, type: 'weekly', period: r.period },
          { attempts: 3, removeOnComplete: 100 },
        );
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  cronConsumer.on('error', (err) => console.error('[reports-cron] consumer error', err));

  logger.log(
    `[worker-web] started: concurrency=${concurrency}, queues=[collect,${REPUTATION_QUEUE},${REPORTS_QUEUE}], browser=${process.env.BROWSER_MODE ?? 'mock'}`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`[worker-web] received ${signal}, draining...`);
    scheduler.stop();
    await loginManager.stop();
    await Promise.allSettled([
      collectWorker.close(),
      reputationWorker.close(),
      reportsWorker.close(),
      cronConsumer.close(),
      cronQueue.close(),
      collect.shutdown(),
      loginRedis.quit(),
    ]);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  // 启动失败必须显式退出:让 SAE/容器编排重启,而不是半死进程空占实例
  console.error('[worker-web] bootstrap failed:', err);
  process.exit(1);
});
