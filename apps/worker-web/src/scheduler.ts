import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { loadPlatformSettings } from '@geo/db';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import {
  WEB_ENGINES,
  WORKER_HEARTBEAT_KEY,
  type PlatformSettings,
} from '@geo/shared';
import {
  collectionPlans,
  collectionRounds,
  monitoringQuestions,
  subscriptions,
} from '@geo/db';
import { COLLECT_QUEUE, bullConnection, priorityOf, type CollectJobData } from './queue';
import { EngineBreaker } from './breaker';

/** 单 tick 的派发预算:全局与每引擎剩余额度(Infinity = 不限),随入队扣减。 */
export interface Budget {
  globalRemaining: number;
  engineRemaining: Map<string, number>;
}

/** 多实例互斥锁键:同一时刻全集群只允许一个 tick 在派发(防双发烧配额)。 */
const TICK_LOCK_KEY = "hashtext('geo-scheduler-tick')";

const DAY_MS = 24 * 3600 * 1000;

/** 时区在给定时刻的 UTC 偏移(ms);非法时区回落 +08:00(产品主要市场)。 */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(instant);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUTC - instant.getTime();
  } catch {
    return 8 * 3600 * 1000;
  }
}

/**
 * 次日采集时刻(docs/04 §3.4 拟人化节奏):在品牌时区的 10:00–15:59 白天时段随机,
 * 且距 now ≥ 24h。纯函数(rand 可注入)便于单测。
 *
 * 24h 下限与"次日白天"可能冲突(晚间派发时次日窗口不足 24h):取候选日窗口与
 * [now+24h, ∞) 的交集随机;交集为空(窗口整段早于下限)则顺延到下一日完整窗口,
 * 宁可间隔拉长也不在同一自然日跑两轮(每日一轮的口径承诺)。
 */
export function nextRunAtFrom(now: Date, timezone: string, rand: () => number = Math.random): Date {
  const minAt = now.getTime() + DAY_MS;
  /** 品牌时区某本地日指定分钟数的墙钟 → instant(偏移随目标时刻 DST 变化,迭代一次收敛)。 */
  const buildAt = (year: number, month: number, day: number, minuteOfDay: number): Date => {
    const wall = Date.UTC(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
    const firstGuess = new Date(wall - tzOffsetMs(now, timezone));
    return new Date(wall - tzOffsetMs(firstGuess, timezone));
  };
  const randMinuteIn = (from: Date, to: Date): Date => {
    const span = Math.max(to.getTime() - from.getTime(), 60_000);
    return new Date(from.getTime() + Math.floor((rand() * span) / 60_000) * 60_000);
  };

  // 候选日 = now+24h 落在的品牌本地日期
  const local = new Date(minAt + tzOffsetMs(now, timezone));
  const [y, m, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
  const windowStart = buildAt(y, m, d, 10 * 60);
  const windowEnd = buildAt(y, m, d, 16 * 60); // 15:59 截止(排他)
  const from = Math.max(windowStart.getTime(), minAt);
  if (from < windowEnd.getTime()) {
    return randMinuteIn(new Date(from), windowEnd);
  }
  // 窗口整段早于 24h 下限:下一日完整窗口(其起点必然晚于 now+24h,见单测)
  return randMinuteIn(buildAt(y, m, d + 1, 10 * 60), buildAt(y, m, d + 1, 16 * 60));
}

/**
 * 展开一轮的入队计划(纯函数,便于单测):问题×引擎,受全局与每引擎剩余额度双重截断。
 * 每入队一个任务都复查该引擎余量——只在轮次开始前检查一次的话,"余量 < 题数"的引擎
 * 会被单轮超发(引擎日上限形同虚设)。直接扣减传入的 budget,与派发循环共享同一份账本。
 */
export function planRoundJobs<Q extends { id: number }>(
  questions: ReadonlyArray<Q>,
  engineList: readonly string[],
  budget: Budget,
): Array<{ question: Q; engine: string }> {
  const jobs: Array<{ question: Q; engine: string }> = [];
  for (const question of questions) {
    for (const engine of engineList) {
      if (budget.globalRemaining <= jobs.length) return jobs;
      const left = budget.engineRemaining.get(engine) ?? 0;
      if (left <= 0) continue; // 该引擎今日额度已尽:跳过,不超发
      budget.engineRemaining.set(engine, left - 1);
      jobs.push({ question, engine });
    }
  }
  return jobs;
}

/**
 * 轮次调度器(docs/04 §5 轮次触发):
 * 每 tick 扫描到期计划 → 建轮次 → 展开 问题×引擎 为 QueryRun 任务入队
 * → next_run_at = 次日品牌时区白天随机化(docs/04 §3.4)。
 * 首轮由"问题配置完成"触发(API 侧把 next_run_at 置 now)。
 *
 * 平台级约束(管理后台配置,@see PlatformSettings):
 * scheduler_enabled 总开关停派发;全局/每引擎每日上限按 tick 预算扣减,
 * 预算内装不下的轮次截断入队(totals 按实际入队数),次日预算恢复后自然续上。
 * 每 tick 写心跳,管理后台总览据此判活。
 */
export class RoundScheduler {
  private timer?: NodeJS.Timeout;
  private concurrency = 4;
  private ticking = false; // 重入护栏:上一 tick 未完成(如 DB 抖动)时不叠加派发
  private readonly queue = new Queue<CollectJobData>(COLLECT_QUEUE, {
    connection: bullConnection(),
  });
  private readonly redis = new Redis(bullConnection().url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  private readonly breaker = new EngineBreaker(this.redis);

  constructor(private readonly db: Db) {}

  start(intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000), concurrency?: number): void {
    this.concurrency = concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4);
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('[scheduler] tick failed', err));
    }, intervalMs);
    void this.tick().catch((err) => console.error('[scheduler] first tick failed', err)); // 启动即跑一轮,不等间隔
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.redis.disconnect();
    await this.queue.close();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    // 多实例互斥(docs/07 定时弹性可横向扩容):pg 会话级 advisory lock,
    // 拿不到锁说明另一实例正在派发;实例崩溃连接断开,锁自动释放。
    const pool = (this.db as unknown as { $client?: Pool }).$client;
    let lockClient: PoolClient | null = null;
    try {
      if (pool) {
        lockClient = await pool.connect();
        const locked = await lockClient.query<{ locked: boolean }>(
          `select pg_try_advisory_lock(${TICK_LOCK_KEY}) as locked`,
        );
        if (!locked.rows[0]?.locked) {
          return; // 其他实例正在派发,本 tick 直接让位
        }
      }
      try {
        await this.heartbeat();
        const settings = await loadPlatformSettings(this.db);
        if (!settings.schedulerEnabled) return; // 总开关:停派发,心跳照写,在途任务不回收

        const budget = await this.buildBudget(settings);
        if (budget.globalRemaining <= 0) {
          console.warn('[scheduler] 全局每日任务上限已达,今日暂停派发(管理后台可调整)');
          return;
        }

        const due = await this.db
          .select()
          .from(collectionPlans)
          .where(
            and(
              eq(collectionPlans.active, true),
              sql`${collectionPlans.nextRunAt} is not null and ${collectionPlans.nextRunAt} <= now()`,
            ),
          )
          // 到期早的先派发:同优先级下近似品牌轮转 fair-share(docs/04 §5)
          .orderBy(collectionPlans.nextRunAt)
          .limit(50);

        for (const plan of due) {
          const canContinue = await this.dispatchRound(plan.brandId, plan.engines as string[], budget);
          // 次日白天随机(品牌时区,docs/04 §3.4:每日总量按地域时区白天重、夜间轻)
          const nextRunAt = nextRunAtFrom(new Date(), plan.timezone);
          await this.db
            .update(collectionPlans)
            .set({ nextRunAt })
            .where(eq(collectionPlans.id, plan.id));
          if (!canContinue) {
            console.warn('[scheduler] 全局每日预算耗尽,剩余计划明日续派');
            break;
          }
        }
      } finally {
        if (lockClient) await lockClient.query(`select pg_advisory_unlock(${TICK_LOCK_KEY})`);
      }
    } finally {
      if (lockClient) lockClient.release();
      this.ticking = false;
    }
  }

  /** 每 tick 覆写心跳(EX 300s);管理后台总览 3×间隔内视为在线。 */
  private async heartbeat(): Promise<void> {
    try {
      await this.redis.set(
        WORKER_HEARTBEAT_KEY,
        JSON.stringify({ ts: Date.now(), concurrency: this.concurrency }),
        'EX',
        300,
      );
    } catch (err) {
      console.error('[scheduler] heartbeat failed', err);
    }
  }

  private async buildBudget(settings: PlatformSettings): Promise<Budget> {
    const used = await this.todayRunCounts();
    const usedTotal = [...used.values()].reduce((a, b) => a + b, 0);
    const globalRemaining = settings.globalDailyRunCap > 0
      ? Math.max(settings.globalDailyRunCap - usedTotal, 0)
      : Number.POSITIVE_INFINITY;
    const engineRemaining = new Map<string, number>();
    for (const engine of WEB_ENGINES) {
      const cap = settings.engineDailyCaps[engine] ?? 0;
      engineRemaining.set(
        engine,
        cap > 0 ? Math.max(cap - (used.get(engine) ?? 0), 0) : Number.POSITIVE_INFINITY,
      );
    }
    return { globalRemaining, engineRemaining };
  }

  private async todayRunCounts(): Promise<Map<string, number>> {
    const res = await this.db.execute(sql`
      select engine, count(*)::int as count
      from query_runs
      where ran_at >= date_trunc('day', now())
      group by engine
    `);
    const rows = (res as unknown as { rows: Array<{ engine: string; count: number }> }).rows;
    return new Map(rows.map((r) => [r.engine, r.count]));
  }

  /** 返回 false = 全局预算耗尽,调用方应停止处理后续计划。 */
  private async dispatchRound(brandId: number, engines: string[], budget: Budget): Promise<boolean> {
    const questions = await this.db
      .select()
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));
    if (questions.length === 0) return true;

    const sub = (
      await this.db.select().from(subscriptions).where(eq(subscriptions.brandId, brandId)).limit(1)
    )[0];
    // 过期/停用订阅不派发(按原计划付费口径,docs/01 §3.10)。订阅行没有自动到期降档任务,
    // status 会一直停在 active——必须同时校验 periodEnd,否则过期套餐仍按付费档消耗采集配额
    if (!sub || sub.accountId == null) return true;
    if ((sub.status && sub.status !== 'active') || !sub.periodEnd || sub.periodEnd.getTime() <= Date.now()) {
      return true;
    }
    const accountId = sub.accountId;
    const priority = priorityOf(sub?.plan ?? 'free');

    // 生效引擎 = 订阅档位的引擎面(WEB_ENGINES 前 N 个,单一事实源=订阅行 engineQuota.web)。
    // collectionPlans.engines 是建号/结算时物化的缓存,档位升级后可能滞后(实测升级到
    // 5 引擎仍派 3 引擎)→ 此处按订阅校正并回写缓存,下一轮起任务数 = 题数 × 新引擎数。
    let cached = engines.filter((e) => (WEB_ENGINES as readonly string[]).includes(e));
    const quotaWeb = (sub.engineQuota as { web?: number } | null)?.web;
    if (typeof quotaWeb === 'number' && quotaWeb > 0) {
      const effective = WEB_ENGINES.slice(0, quotaWeb);
      const same = effective.length === cached.length && effective.every((e) => cached.includes(e));
      if (!same) {
        console.warn(
          `[scheduler] brand=${brandId} 引擎面与订阅档位不一致(${cached.join('/')} → ${effective.join('/')}),已校正`,
        );
        cached = effective;
        await this.db
          .update(collectionPlans)
          .set({ engines: effective as unknown as string[] })
          .where(eq(collectionPlans.brandId, brandId));
      }
    }

    // 引擎三重过滤:白名单 + 引擎日预算 + 熔断/手动暂停(熔断中不入队,避免任务堆积延迟重排)
    const engineList: string[] = [];
    for (const e of cached) {
      if (!(WEB_ENGINES as readonly string[]).includes(e)) continue;
      if ((budget.engineRemaining.get(e) ?? 0) <= 0) continue;
      if (await this.breaker.isTripped(e)) continue;
      engineList.push(e);
    }
    if (engineList.length === 0) return true;

    // 入队计划:每任务复查全局/引擎额度(纯函数,预算账本被就地扣减)
    const jobs = planRoundJobs(questions, engineList, budget);
    if (jobs.length === 0) return true;
    const round = (
      await this.db.insert(collectionRounds).values({ brandId }).returning()
    )[0]!;

    // totals 先行写入(only-total):避免与 processor 的 done 增量发生"先增后覆盖"竞态
    await this.db
      .update(collectionRounds)
      .set({ totals: { total: jobs.length, enqueued: 0, done: 0, ok: 0, failed: 0 } })
      .where(eq(collectionRounds.id, round.id));

    let enqueued = 0;
    for (const job of jobs) {
      await this.queue.add(
        'collect',
        {
          runId: 0, // 执行时落库获得真实 id
          brandId,
          accountId,
          roundId: round.id,
          questionId: job.question.id,
          questionType: job.question.type as 'ranking' | 'reputation',
          questionText: job.question.textExpanded,
          engine: job.engine,
          surface: 'web',
          priority,
        },
        {
          jobId: `round${round.id}-q${job.question.id}-${job.engine}`,
          priority,
          // 执行前段(熔断检查/账号池/延迟重排)依赖 DB/Redis,抛错默认 1 次即终态:
          // 样本静默丢失且轮次进度永久卡死——给一次快速重试让瞬时抖动自愈
          attempts: 2,
          backoff: { type: 'fixed', delay: 5_000 },
          // 采集载荷大(含问题文本),completed/failed 只留最近 500 条防 Redis 无界增长
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
      enqueued += 1;
    }
    budget.globalRemaining -= enqueued;

    // 只补 enqueued 键,不覆盖 processor 已增量写入的 done/ok/failed
    if (enqueued !== jobs.length) {
      await this.db.execute(sql`
        update collection_rounds
        set totals = jsonb_set(totals, '{enqueued}', ${enqueued}::text::jsonb)
        where id = ${round.id}
      `);
    }

    return budget.globalRemaining > 0;
  }
}
