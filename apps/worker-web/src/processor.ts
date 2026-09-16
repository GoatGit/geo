import { eq, sql } from 'drizzle-orm';
import { and } from 'drizzle-orm';
import { brands, collectionRounds, monitoringQuestions, queryRuns, recognitionEntries, type Db } from '@geo/db';
import {
  MockEngineAdapter,
  AdapterRegistry,
  DomWebAdapter,
  needsLoginOf,
  type AskResult,
} from '@geo/engine-adapters';
import { WEB_ENGINES, type AskStatus } from '@geo/shared';
import { browserModeFromEnv, createBrokerFromEnv, fingerprintHash, type SessionBroker } from '@geo/browser-session';
import { buildEvidencePack, createStorageFromEnv } from '@geo/evidence';
import Redis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { EngineBreaker } from './breaker';
import { envInt } from './config';
import { AccountPoolService, type AcquiredProfile } from './profiles';
import {
  COLLECT_QUEUE,
  REDIS_PROGRESS_CHANNEL,
  REPUTATION_QUEUE,
  bullConnection,
  type CollectJobData,
} from './queue';
import { discoverCompetitors, runInstantExtraction, toSubjects, type SubjectDef, type SubjectRow } from './extraction';

/** 失败重试上限(docs/04 §5:重试最多 2 次,必须更换账号):1 次首发 + 2 次轮换重试。 */
const MAX_ATTEMPTS = envInt('COLLECT_ATTEMPTS', 3, 1, 5);
/** 延迟重排上限:熔断(60s/次)或账号池耗尽(120s/次)累计等待约 15-30 分钟后收口为 quota_blocked。 */
const MAX_DEFERRED = envInt('COLLECT_MAX_DEFERRED', 15, 1, 100);
/** 单次 ask 超时:挂死的会话不能永久占用 worker 并发槽(视为 failed,进熔断/健康分)。 */
const ASK_TIMEOUT_MS = envInt('ASK_TIMEOUT_MS', 120_000, 10_000, 600_000);
const RETRY_BACKOFF_MS = envInt('COLLECT_RETRY_BACKOFF_MS', 3_000, 0, 60_000);

/**
 * 采集执行链(docs/04 §1 总体结构):
 * 领取账号 → SessionBroker.acquire → 引擎适配器 ask(超时护栏)→ 失败换账号重试
 * → 证据包落存 → QueryRun 四态回写 → 即时抽取(mention/citation)
 * → 口碑入异步队列 → 进度推送(Redis → WS 网关)。
 * Worker 不理解业务指标——只负责忠实采集与存证(docs/04 §1 分层原则)。
 */
export class CollectProcessor {
  private readonly requeue = new Queue(COLLECT_QUEUE, { connection: bullConnection() });
  private readonly reputation = new Queue(REPUTATION_QUEUE, { connection: bullConnection() });
  private readonly progressRedis = new Redis(bullConnection().url, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 1_000, 10_000),
  });
  private readonly breaker: EngineBreaker;
  private readonly pool: AccountPoolService;
  private readonly storage = createStorageFromEnv();
  private readonly registry = new AdapterRegistry();

  constructor(
    private readonly db: Db,
    redis: Redis,
    private readonly broker: SessionBroker = createBrokerFromEnv(),
  ) {
    this.breaker = new EngineBreaker(redis);
    this.pool = new AccountPoolService(db);
    // 适配器按 BROWSER_MODE 装配:mock=回放(dev/CI);agentbay/local=真实 DOM 采集(docs/04 §2.1)
    this.realBrowser = browserModeFromEnv() !== 'mock';
    for (const engine of WEB_ENGINES) {
      this.registry.register(
        this.realBrowser ? new DomWebAdapter(engine) : MockEngineAdapter.withDefaultFixtures(engine),
      );
    }
  }

  private readonly realBrowser: boolean;

  start(concurrency: number): Worker<CollectJobData> {
    const worker = new Worker<CollectJobData>(COLLECT_QUEUE, (job) => this.process(job), {
      connection: bullConnection(),
      concurrency,
    });
    worker.on('error', (err) => console.error('[collect] worker error', err));
    return worker;
  }

  async shutdown(): Promise<void> {
    this.progressRedis.disconnect();
    await this.broker.destroyAll?.(); // 本地代理:关闭残留浏览器进程(登录态已持久化到 profile 目录)
    await Promise.allSettled([this.requeue.close(), this.reputation.close()]);
  }

  async process(job: Job<CollectJobData>): Promise<{ status: AskStatus | 'deferred' }> {
    const data = job.data;
    const engine = data.engine;
    const startedAt = Date.now();
    const deferredCount = data.deferredCount ?? 0;

    // 延迟重排上限:熔断/账号池长时间不恢复时,任务不能无限自我复制(docs/02 §1.1:
    // 配额拦截必须可见)——落 quota_blocked 四态收口,轮次进度同步走完
    if (deferredCount >= MAX_DEFERRED) {
      console.error(
        `[collect] engine=${engine} brand=${data.brandId} 延迟重排 ${deferredCount} 次仍未执行,落 quota_blocked 收口`,
      );
      await this.recordQuotaBlocked(data);
      await this.bumpRound(data.roundId, 'quota_blocked').catch(() => undefined);
      return { status: 'deferred' };
    }

    // 熔断(docs/04 §5):该引擎通道维护中 → 延迟重排,不产生 failed 污染口径
    if (await this.breaker.isTripped(engine)) {
      await this.requeue.add('collect', { ...data, deferredCount: deferredCount + 1 }, { delay: 60_000, priority: data.priority });
      return { status: 'deferred' };
    }

    // 首发领取账号;重试强制换号(docs/04 §5),池耗尽则整单延迟重排
    const triedProfileIds = new Set<number>();
    let ask = this.failedAsk(new Date(), 'account pool exhausted');
    let profile = await this.pool.acquire(engine);
    if (!profile) {
      // 账号池耗尽(docs/04 §3.2):延迟重排,扩容与冗余由运营策略解决
      await this.requeue.add('collect', { ...data, deferredCount: deferredCount + 1 }, { delay: 120_000, priority: data.priority });
      return { status: 'deferred' };
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      triedProfileIds.add(profile.id);
      ask = await this.askWithTimeout(engine, profile, data.questionText);
      await this.breaker.record(engine, ask.status !== 'failed');
      if (needsLoginOf(ask)) {
        // 登录态失效是账号供给问题而非滥用:不扣健康分,置 login_required 等人工重登(docs/04 §3.1)
        await this.pool.markLoginRequired(profile.id);
        console.error(
          `[collect] engine=${engine} profile=${profile.id} 登录态失效,已置 login_required(后台"账号池"可重新人工登录)`,
        );
      } else {
        await this.pool.report(engine, profile.id, ask.status !== 'failed');
      }
      if (ask.status !== 'failed') break;
      console.error(
        `[collect] run attempt ${attempt}/${MAX_ATTEMPTS} failed engine=${engine} brand=${data.brandId} ` +
          `profile=${profile.id} cost=${Date.now() - startedAt}ms error=${String(ask.engineMeta?.error ?? 'unknown')}`,
      );
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      const next = await this.pool.acquire(engine, triedProfileIds);
      if (!next) break; // 无号可换:以最后一次失败定格,等账号池恢复
      profile = next;
    }

    // ===== QueryRun 四态回写(docs/02 §1.1)=====
    // 采集结果已定格,后续落库/存证/抽取环节的异常不重放整个 job(会重复采集),
    // 而是把该 run 标记 failed 并保留现场日志。
    const ranAt = new Date();
    const adapter = this.registry.get(engine as never, 'web');
    let runId: number | undefined;
    try {
      const runRow = (
        await this.db
          .insert(queryRuns)
          .values({
            brandId: data.brandId,
            questionId: data.questionId,
            engine,
            surface: 'web',
            roundId: data.roundId,
            status: ask.status,
            adapterVersion: adapter.schemaVersion,
            accountFingerprint: fingerprintHash(profile.profileKey),
            ranAt,
            // 失败原因落 meta:失败必须可诊断(展示层透出,docs/02 §1.1 可见性)
            ...(ask.status === 'failed'
              ? { meta: { error: String(ask.engineMeta?.error ?? 'unknown') } }
              : {}),
          })
          .returning({ id: queryRuns.id })
      )[0]!;
      runId = runRow.id;

      const pack = buildEvidencePack({
        runId: String(runId),
        brandId: data.brandId,
        engine,
        surface: 'web',
        adapterVersion: adapter.schemaVersion,
        question: data.questionText,
        accountFingerprint: fingerprintHash(profile.profileKey),
        status: ask.status,
        answerText: ask.answerText,
        rawHtml: ask.rawHtml,
        citations: ask.citations,
        timing: ask.timing,
        engineMeta: ask.engineMeta,
      });
      for (const f of pack.files) await this.storage.put(f.path, f.body);

      await this.db
        .update(queryRuns)
        .set({
          answerRef: pack.refs.answerRef,
          snapshotRef: pack.refs.snapshotRef,
          recordingRef: pack.refs.recordingRef,
          evidenceHash: pack.manifestHash,
          // 合并而非覆盖:失败原因(insert 时写入)必须保留
          meta: sql`coalesce(query_runs.meta, '{}'::jsonb) || ${JSON.stringify({
            priority: data.priority,
            strategy: adapter.strategy,
          })}::jsonb`,
        })
        .where(eq(queryRuns.id, runId));

      // ===== 即时抽取(ok_* 才进口径)=====
      // 抽取失败不回改 run 状态:事实缺失只是样本损失,状态与事实互相矛盾更伤口径
      if (ask.status !== 'failed') {
        await this.extractAndEnqueue(data, runId, engine, ranAt, ask, adapter.strategy).catch((err) =>
          console.error(`[collect] extract failed run=${runId} engine=${engine}:`, err),
        );
      }

      // 状态已定格:进度推送/轮次计数失败只记日志,成功 run 不因旁路故障降级为 failed
      await this.publishProgress(data, ask.status, runId).catch((err) =>
        console.error(`[collect] progress publish failed run=${runId}:`, err),
      );
      await this.bumpRound(data.roundId, ask.status).catch((err) =>
        console.error(`[collect] bump round failed run=${runId}:`, err),
      );
    } catch (err) {
      console.error(
        `[collect] persist failed run=${runId ?? 'n/a'} engine=${engine} brand=${data.brandId}:`,
        err,
      );
      // 落库失败(含 insert 本身失败)也要给轮次收口计数,否则轮次进度漂移、永远走不完
      await this.bumpRound(data.roundId, 'failed').catch(() => undefined);
      if (runId !== undefined) {
        await this.db
          .update(queryRuns)
          .set({ status: 'failed', meta: { priority: data.priority, strategy: adapter.strategy, error: String(err) } })
          .where(eq(queryRuns.id, runId))
          .catch(() => undefined);
      }
      return { status: 'failed' };
    }

    console.log(
      `[collect] run=${runId} engine=${engine} brand=${data.brandId} status=${ask.status} ` +
        `attempts=${triedProfileIds.size} cost=${Date.now() - startedAt}ms`,
    );
    return { status: ask.status };
  }

  /** 单次 ask,带超时护栏:超时按 failed 处理并释放会话,不占用并发槽。 */
  private async askWithTimeout(engine: string, profile: AcquiredProfile, questionText: string): Promise<AskResult> {
    const queuedAt = new Date();
    let cdpBrowser: Browser | null = null;
    try {
      const session = await this.broker.acquire({
        profileKey: profile.profileKey,
        contextRef: profile.contextRef ?? undefined,
        fingerprint: profile.fingerprint,
        proxyHint: profile.proxyHint ?? undefined,
        purpose: 'collect',
      });
      try {
        // 本地代理直接注入 Page;远程代理(AgentBay)经 CDP 连接拿页面
        let page = session.page as Page | undefined;
        if (!page && /^wss?:\/\//.test(session.cdpUrl)) {
          cdpBrowser = await chromium.connectOverCDP(session.cdpUrl);
          const context = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
          page = context.pages()[0] ?? (await context.newPage());
        }
        const adapter = this.registry.get(engine as never, 'web');
        return await adapter.ask(
          {
            mode: this.realBrowser ? 'browser' : 'mock',
            page,
            fingerprint: profile.fingerprint,
            proxyHint: profile.proxyHint ?? undefined,
            profileKey: profile.profileKey,
          },
          questionText,
          { timeoutMs: ASK_TIMEOUT_MS },
        );
      } finally {
        await session.release();
        if (cdpBrowser) await cdpBrowser.close().catch(() => undefined); // CDP 连接的 close 只断连,不关远端浏览器
      }
    } catch (err) {
      // 超时/会话异常/无适配器统一按 failed 定格(docs/04 §7 失败模式手册)
      return this.failedAsk(queuedAt, (err as Error).message);
    }
  }

  private failedAsk(queuedAt: Date, error: string): AskResult {
    const now = new Date().toISOString();
    return {
      status: 'failed' as const,
      answerText: '',
      rawHtml: null,
      citations: [],
      timing: { queuedAt: queuedAt.toISOString(), firstTokenAt: now, completedAt: now },
      engineMeta: { error },
    };
  }

  private async extractAndEnqueue(
    data: CollectJobData,
    runId: number,
    engine: string,
    ranAt: Date,
    ask: { answerText: string; citations: Array<{ url: string; title?: string }> },
    strategy: string,
  ): Promise<void> {
    const [subjects, brand] = await Promise.all([this.loadSubjects(data.brandId), this.loadBrand(data.brandId)]);
    const ownedHost = brand?.website ? brand.website.replace(/^https?:\/\//, '').split('/')[0] : '';

    const { facts } = await runInstantExtraction({
      db: this.db,
      runId,
      brandId: data.brandId,
      questionId: data.questionId,
      engine,
      ranAt,
      answerText: ask.answerText,
      citations: ask.citations,
      subjects,
      ownedDomains: ownedHost ? [ownedHost] : [],
    });

    await this.db
      .update(queryRuns)
      .set({ meta: { priority: data.priority, strategy, facts: facts.length } })
      .where(eq(queryRuns.id, runId));

    // 竞品自动发现(未匹配高频实体,异步低优先;失败只记日志,不影响主链路)
    void discoverCompetitors({ db: this.db, brandId: data.brandId, answerText: ask.answerText, subjects }).catch(
      (err) => console.error(`[collect] competitor discovery failed run=${runId}:`, err),
    );

    if (data.questionType === 'reputation' && ask.answerText) {
      await this.reputation.add(
        'extract',
        { runId, brandId: data.brandId, answerText: ask.answerText, ranAt: ranAt.toISOString() },
        { attempts: 3, removeOnComplete: 100 },
      );
    }
  }

  private async loadBrand(brandId: number): Promise<{ website: string | null } | undefined> {
    return (
      await this.db.select({ website: brands.website }).from(brands).where(eq(brands.id, brandId)).limit(1)
    )[0];
  }

  private async loadSubjects(brandId: number): Promise<SubjectDef[]> {
    const rows = (await this.db
      .select()
      .from(recognitionEntries)
      .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.confirmed, true)))) as SubjectRow[];
    const brandName =
      (
        await this.db.select({ name: brands.name }).from(brands).where(eq(brands.id, brandId)).limit(1)
      )[0]?.name ?? '';
    return toSubjects(rows, brandName);
  }

  private async publishProgress(data: CollectJobData, status: AskStatus | 'deferred', runId: number): Promise<void> {
    try {
      const q = await this.db
        .select({ text: monitoringQuestions.textExpanded })
        .from(monitoringQuestions)
        .where(eq(monitoringQuestions.id, data.questionId))
        .limit(1);
      await this.progressRedis.publish(
        REDIS_PROGRESS_CHANNEL,
        JSON.stringify({
          accountId: data.accountId,
          payload: {
            brandId: data.brandId,
            roundId: data.roundId,
            runId,
            engine: data.engine,
            question: q[0]?.text ?? data.questionText,
            status,
            at: new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      console.error(`[collect] progress publish failed run=${runId}:`, err); // 进度推送失败不影响采集主链路
    }
  }

  private async bumpRound(roundId: number, status: AskStatus | 'deferred' | 'quota_blocked'): Promise<void> {
    // 单次赋值嵌套 jsonb_set:UPDATE 中所有引用都看旧行,链式嵌套安全;分开两次赋值会报
    // "multiple assignments to same column totals"(仅失败轮次触发,曾掩盖真实失败原因)
    const okInc = status === 'failed' || status === 'deferred' || status === 'quota_blocked' ? 0 : 1;
    const failInc = status === 'failed' ? 1 : 0;
    const blockedInc = status === 'quota_blocked' ? 1 : 0;
    await this.db.execute(sql`
      update collection_rounds
      set totals = jsonb_set(jsonb_set(jsonb_set(jsonb_set(coalesce(totals, '{}'::jsonb),
            '{done}', (coalesce((totals->>'done')::int, 0) + 1)::text::jsonb),
            '{ok}', (coalesce((totals->>'ok')::int, 0) + ${okInc})::text::jsonb),
            '{failed}', (coalesce((totals->>'failed')::int, 0) + ${failInc})::text::jsonb),
            '{quota_blocked}', (coalesce((totals->>'quota_blocked')::int, 0) + ${blockedInc})::text::jsonb)
      where id = ${roundId}
    `);
    const round = (await this.db.select().from(collectionRounds).where(eq(collectionRounds.id, roundId)).limit(1))[0];
    const totals = round?.totals as { total?: number; done?: number } | null;
    if (totals && totals.total && (totals.done ?? 0) >= totals.total) {
      await this.db
        .update(collectionRounds)
        .set({ finishedAt: new Date() })
        .where(eq(collectionRounds.id, roundId));
    }
  }

  /** 延迟重排超限收口:落 quota_blocked run(docs/02 §1.1 四态之配额拦截,必须可见)。 */
  private async recordQuotaBlocked(data: CollectJobData): Promise<void> {
    await this.db
      .insert(queryRuns)
      .values({
        brandId: data.brandId,
        questionId: data.questionId,
        engine: data.engine,
        surface: 'web',
        roundId: data.roundId,
        status: 'quota_blocked',
        ranAt: new Date(),
        meta: { deferredCount: data.deferredCount ?? 0 },
      })
      .catch((err) => console.error('[collect] record quota_blocked failed:', err));
  }
}
