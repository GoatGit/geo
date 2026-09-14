import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { loadPlatformSettings } from '@geo/db';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
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

/** 单 tick 的派发预算:全局与每引擎剩余额度(Infinity = 不限),随入队扣减。 */
export interface Budget {
  globalRemaining: number;
  engineRemaining: Map<string, number>;
}

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
 * 保证距 now ≥ 24h。纯函数(rand 可注入)便于单测。
 */
export function nextRunAtFrom(now: Date, timezone: string, rand: () => number = Math.random): Date {
  const targetWall = now.getTime() + DAY_MS + tzOffsetMs(now, timezone);
  const local = new Date(targetWall);
  const hour = 10 + Math.floor(rand() * 6);
  const minute = Math.floor(rand() * 60);
  const wall = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
    0,
  );
  // 墙钟 → instant:偏移随目标时刻的 DST 变化,迭代一次收敛
  const firstGuess = new Date(wall - tzOffsetMs(now, timezone));
  return new Date(wall - tzOffsetMs(firstGuess, timezone));
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
        .limit(50);

      for (const plan of due) {
        const canContinue = await this.dispatchRound(plan.brandId, plan.engines as string[], plan.timezone, budget);
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
  private async dispatchRound(
    brandId: number,
    engines: string[],
    _timezone: string,
    budget: Budget,
  ): Promise<boolean> {
    void _timezone;
    const questions = await this.db
      .select()
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));
    if (questions.length === 0) return true;

    const sub = (
      await this.db.select().from(subscriptions).where(eq(subscriptions.brandId, brandId)).limit(1)
    )[0];
    const accountId = sub?.accountId;
    if (!accountId) return true;
    const priority = priorityOf(sub?.plan ?? 'free');

    const engineList = engines.filter(
      (e) => (WEB_ENGINES as readonly string[]).includes(e) && (budget.engineRemaining.get(e) ?? 0) > 0,
    );
    if (engineList.length === 0) return true;

    const maxJobs = Math.min(budget.globalRemaining, questions.length * engineList.length);
    const round = (
      await this.db.insert(collectionRounds).values({ brandId }).returning()
    )[0]!;

    let enqueued = 0;
    for (const q of questions) {
      for (const engine of engineList) {
        if (enqueued >= maxJobs) break;
        await this.queue.add(
          'collect',
          {
            runId: 0, // 执行时落库获得真实 id
            brandId,
            accountId,
            roundId: round.id,
            questionId: q.id,
            questionType: q.type as 'ranking' | 'reputation',
            questionText: q.textExpanded,
            engine,
            surface: 'web',
            priority,
          },
          { jobId: `round${round.id}-q${q.id}-${engine}`, priority },
        );
        enqueued += 1;
        budget.engineRemaining.set(engine, (budget.engineRemaining.get(engine) ?? 0) - 1);
      }
      if (enqueued >= maxJobs) break;
    }
    budget.globalRemaining -= enqueued;

    // totals 按实际入队数:预算截断的轮次进度仍可走完,缺口次日由新轮次补齐
    await this.db
      .update(collectionRounds)
      .set({ totals: { total: enqueued, enqueued, done: 0, ok: 0, failed: 0 } })
      .where(eq(collectionRounds.id, round.id));

    return budget.globalRemaining > 0;
  }
}
