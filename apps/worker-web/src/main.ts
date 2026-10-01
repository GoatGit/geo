import Redis from 'ioredis';
import { createDb, ensurePartitions, runMigrations } from '@geo/db';
import { REPUTATION_QUEUE, REPORTS_QUEUE, bullConnection } from './queue';
import { envInt } from './config';
import { CollectProcessor } from './processor';
import { LoginManager } from './login-manager';
import { RoundScheduler } from './scheduler';
import { Alerter } from './alerts';
import { backfillCitationTitles } from './citation-titles';
import { classifyUnknownDomains, refreshDomainDict } from './domain-classifier';
import { AccountPoolService } from './profiles';
import { ProxyPoolManager } from './qg-proxy';
import { startReportsWorker, startReputationWorker, scheduleWeeklyReports } from './report-worker';
import { startInsightsWorker, scheduleWeeklyInsights } from './insights-worker';
import { browserModeFromEnv, createBrokerFromEnv } from '@geo/browser-session';
import { PersonaLibraryWorker } from './persona-library-worker';
import { SurveyWorker } from './survey-worker';

/**
 * Worker 启动(docs/07 §3):
 * 幂等迁移(只加不改)→ 分区预建 → 调度器 → 采集/口碑/报告/洞察消费器 → 优雅退出。
 * 启动自迁移是生产的标准迁移通道(RDS 公网不可达,本地无法直连执行 db:migrate);
 * 多实例同时启动时迁移各自串行加锁执行,幂等无冲突。
 */
/** 告警去重用的 Redis(与采集连接隔离,lazyConnect 断连互不影响)。 */
function collectRedisForAlerts() {
  // ioredis CJS 互操作:运行时 default 才是构造器,类型上双断言
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Mod = require('ioredis') as { default?: unknown } & Record<string, unknown>;
  const Ctor = (Mod.default ?? Mod) as new (url: string, opts?: Record<string, unknown>) => import('ioredis').default;
  return new Ctor(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
}

async function bootstrap() {
  const { pool, db } = createDb(process.env.DATABASE_URL ?? 'postgres://geo:geo_dev@localhost:5432/geo');
  const logger = console;

  const applied = await runMigrations(pool);
  if (applied.length > 0) logger.log(`[worker-web] applied migrations: ${applied.join(', ')}`);
  await ensurePartitions(pool, 2);

  const alerter = new Alerter(collectRedisForAlerts(), process.env.ALERT_WEBHOOK_URL ?? '');
  const scheduler = new RoundScheduler(db);
  const concurrency = envInt('WORKER_CONCURRENCY', 4, 1, 64);
  scheduler.start(undefined, concurrency); // 间隔经 SCHEDULER_INTERVAL_MS 配置(默认 60s);并发数随心跳上报

  // mock 采集模式下确保账号池非空:池空会导致任务无限延迟重排、采集静默空转。
  // 补种失败(如 DB 缺列且迁移未跑)不阻塞启动——采集与登录主链路不依赖它。
  // browserModeFromEnv 在生产缺省/无效 BROWSER_MODE 时直接抛错退出(fail-safe,防假数据入库)
  const browserMode = browserModeFromEnv();
  if (browserMode === 'mock') {
    await new AccountPoolService(db)
      .ensureMockProfiles(2)
      .catch((err) => logger.error('[worker-web] mock 档案补种失败(不阻塞启动):', (err as Error).message));
  }

  // 全进程共享一个 broker:采集与人工登录(refcount 复用本地浏览器进程/登录态)
  const broker = createBrokerFromEnv();
  // 青果代理池(闸门 #2):平台配置(platform_settings)优先,env 兜底;60s 热加载
  const proxyPool = new ProxyPoolManager(db, process.env.QG_PROXY_KEY ?? '');
  await proxyPool.bootstrap();
  proxyPool.start();
  const collect = new CollectProcessor(db, new Redis(bullConnection().url, { maxRetriesPerRequest: 3 }), broker, proxyPool, alerter);
  const collectWorker = collect.start(concurrency);

  const loginRedis = new Redis(bullConnection().url, { maxRetriesPerRequest: null });
  const loginManager = new LoginManager(db, loginRedis, broker, proxyPool);
  loginManager.start();

  const reputationWorker = startReputationWorker(
    db,
    new Redis(bullConnection().url, { maxRetriesPerRequest: 1 }), // Insight Agent 调用统计(docs/09 §10)
  );
  const reportsWorker = startReportsWorker(db);
  const insightsWorker = startInsightsWorker(db);
  // 启动即回收僵死的行业洞察构建(实例缩容/崩溃遗留的 running 行,不回收则该行业永久跳过)
  void import('./insight-builder')
    .then(({ reclaimStaleInsightBuilds }) =>
      reclaimStaleInsightBuilds(db).then((n) => n > 0 && console.warn(`[insights] 启动回收 ${n} 个僵死构建`)),
    )
    .catch(() => undefined);
  const surveyWorker = new SurveyWorker(db).start();
  const personaLibraryWorker = new PersonaLibraryWorker(db).start();
  await scheduleWeeklyReports();
  await scheduleWeeklyInsights();

  // 域名字典(docs/14 §32):启动加载;unknown 域名 LLM 识别一次入库,每 30 分钟一轮
  await refreshDomainDict(db);
  const runDomainClassifier = () =>
    void classifyUnknownDomains(db, 8).catch(() => undefined);
  setTimeout(runDomainClassifier, 60_000); // 启动 1 分钟后先清一轮存量
  setInterval(runDomainClassifier, 30 * 60_000);

  // 引用标题回填(docs/14 §33):每 10 分钟补 40 条缺标题引用,启动即跑一轮
  const runTitleBackfill = () =>
    void backfillCitationTitles(db, 120)
      .then((n) => n > 0 && console.log(`[citations] 标题回填 +${n}`))
      .catch(() => undefined);
  runTitleBackfill();
  setInterval(runTitleBackfill, 10 * 60_000);

  // 运营巡检(docs/14 §94):队列积压告警,10 分钟一次
  setInterval(() => {
    void (async () => {
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue('collect', { connection: bullConnection() });
        const counts = await q.getJobCounts('delayed', 'failed');
        await q.close();
        if ((counts.delayed ?? 0) > 200) await alerter.queueBacklog(counts.delayed ?? 0);
      } catch { /* 巡检失败静默 */ }
    })();
  }, 10 * 60_000);

  // 周报 cron 由 reportsWorker 统一消费(见 report-worker.ts):REPORTS_QUEUE 只允许一个
  // consumer,历史上第二个 cronConsumer 与其互相误吞过对方的 job 名。
  logger.log(
    `[worker-web] started: concurrency=${concurrency}, queues=[collect,${REPUTATION_QUEUE},${REPORTS_QUEUE},insights], browser=${browserMode}`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`[worker-web] received ${signal}, draining...`);
    scheduler.stop();
    await loginManager.stop();
    await Promise.allSettled([
      collectWorker.close(),
      reputationWorker.close(),
      reportsWorker.close(),
      insightsWorker.close(),
      surveyWorker.stop(),
      personaLibraryWorker.stop(),
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
