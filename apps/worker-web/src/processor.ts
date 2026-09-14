import { eq, sql } from 'drizzle-orm';
import { and } from 'drizzle-orm';
import { brands, collectionRounds, monitoringQuestions, queryRuns, recognitionEntries, type Db } from '@geo/db';
import { MockEngineAdapter, AdapterRegistry, type AskResult } from '@geo/engine-adapters';
import { WEB_ENGINES, type AskStatus } from '@geo/shared';
import { createBrokerFromEnv, fingerprintHash } from '@geo/browser-session';
import { buildEvidencePack, createStorageFromEnv } from '@geo/evidence';
import Redis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
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
  private readonly broker = createBrokerFromEnv();
  private readonly registry = new AdapterRegistry();

  constructor(
    private readonly db: Db,
    redis: Redis,
  ) {
    this.breaker = new EngineBreaker(redis);
    this.pool = new AccountPoolService(db);
    // dev/CI:mock 适配器;真实引擎适配器在 AgentBay PoC 后按 strategy 落地(docs/07 §13)
    for (const engine of WEB_ENGINES) {
      this.registry.register(MockEngineAdapter.withDefaultFixtures(engine));
    }
  }

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
    await Promise.allSettled([this.requeue.close(), this.reputation.close()]);
  }

  async process(job: Job<CollectJobData>): Promise<{ status: AskStatus | 'deferred' }> {
    const data = job.data;
    const engine = data.engine;
    const startedAt = Date.now();

    // 熔断(docs/04 §5):该引擎通道维护中 → 延迟重排,不产生 failed 污染口径
    if (await this.breaker.isTripped(engine)) {
      await this.requeue.add('collect', data, { delay: 60_000, priority: data.priority });
      return { status: 'deferred' };
    }

    // 首发领取账号;重试强制换号(docs/04 §5),池耗尽则整单延迟重排
    const triedProfileIds = new Set<number>();
    let ask = this.failedAsk(new Date(), 'account pool exhausted');
    let profile = await this.pool.acquire(engine);
    if (!profile) {
      // 账号池耗尽(docs/04 §3.2):延迟重排,扩容与冗余由运营策略解决
      await this.requeue.add('collect', data, { delay: 120_000, priority: data.priority });
      return { status: 'deferred' };
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      triedProfileIds.add(profile.id);
      ask = await this.askWithTimeout(engine, profile, data.questionText);
      await this.breaker.record(engine, ask.status !== 'failed');
      await this.pool.report(engine, profile.id, ask.status !== 'failed');
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
    let runId: number;
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
          meta: { priority: data.priority, strategy: adapter.strategy },
        })
        .where(eq(queryRuns.id, runId));

      // ===== 即时抽取(ok_* 才进口径)=====
      if (ask.status !== 'failed') {
        await this.extractAndEnqueue(data, runId, engine, ranAt, ask, adapter.strategy);
      }

      await this.publishProgress(data, ask.status, runId);
      await this.bumpRound(data.roundId, ask.status);
    } catch (err) {
      console.error(
        `[collect] persist failed run=${runId ?? 'n/a'} engine=${engine} brand=${data.brandId}:`,
        err,
      );
      if (runId !== undefined) {
        await this.db
          .update(queryRuns)
          .set({ status: 'failed', meta: { priority: data.priority, strategy: adapter.strategy, error: String(err) } })
          .where(eq(queryRuns.id, runId))
          .catch(() => undefined);
        await this.bumpRound(data.roundId, 'failed').catch(() => undefined);
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
    try {
      const session = await this.broker.acquire({
        profileKey: profile.profileKey,
        contextRef: profile.contextRef ?? undefined,
        fingerprint: profile.fingerprint,
        proxyHint: profile.proxyHint ?? undefined,
      });
      try {
        const adapter = this.registry.get(engine as never, 'web');
        return await adapter.ask(
          {
            mode: process.env.BROWSER_MODE === 'agentbay' ? 'browser' : 'mock',
            page: undefined, // browser 模式:worker 在此 connectOverCDP(session.cdpUrl) 后注入 Page
            fingerprint: profile.fingerprint,
            proxyHint: profile.proxyHint ?? undefined,
            profileKey: profile.profileKey,
          },
          questionText,
          { timeoutMs: ASK_TIMEOUT_MS },
        );
      } finally {
        await session.release();
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

  private async bumpRound(roundId: number, status: AskStatus | 'deferred'): Promise<void> {
    await this.db.execute(sql`
      update collection_rounds
      set totals = jsonb_set(jsonb_set(totals, '{done}',
            (coalesce((totals->>'done')::int, 0) + 1)::text::jsonb),
          '{ok}',
            (coalesce((totals->>'ok')::int, 0) + ${status === 'failed' || status === 'deferred' ? 0 : 1})::text::jsonb)
      ${status === 'failed' ? sql`, totals = jsonb_set(totals, '{failed}', (coalesce((totals->>'failed')::int, 0) + 1)::text::jsonb)` : sql``}
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
}
