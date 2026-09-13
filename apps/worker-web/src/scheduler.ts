import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { Queue } from 'bullmq';
import {
  collectionPlans,
  collectionRounds,
  monitoringQuestions,
  recognitionEntries,
  subscriptions,
} from '@geo/db';
import { WEB_ENGINES } from '@geo/shared';
import { COLLECT_QUEUE, bullConnection, priorityOf, type CollectJobData } from './queue';

/**
 * 轮次调度器(docs/04 §5 轮次触发):
 * 每分钟扫描到期计划 → 建轮次 → 展开 问题×引擎 为 QueryRun 任务入队
 * → next_run_at = 次日(品牌时区白天随机化,docs/04 §3.4 拟人化节奏)。
 * 首轮由"问题配置完成"触发(API 侧把 next_run_at 置 now)。
 */
export class RoundScheduler {
  private timer?: NodeJS.Timeout;
  private readonly queue = new Queue<CollectJobData>(COLLECT_QUEUE, {
    connection: bullConnection(),
  });

  constructor(private readonly db: Db) {}

  start(intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000)): void {
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('[scheduler] tick failed', err));
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
  }

  async tick(): Promise<void> {
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
      await this.dispatchRound(plan.brandId, plan.engines as string[], plan.timezone);
      // 次日白天随机(docs/04 §3.4:每日总量按地域时区白天重、夜间轻)
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const hour = 10 + Math.floor(Math.random() * 6); // 10:00-15:59
      tomorrow.setUTCHours(hour - 8, Math.floor(Math.random() * 60), 0, 0); // Asia/Shanghai 基准
      await this.db
        .update(collectionPlans)
        .set({ nextRunAt: tomorrow })
        .where(eq(collectionPlans.id, plan.id));
    }
  }

  private async dispatchRound(brandId: number, engines: string[], _timezone: string) {
    void _timezone;
    const questions = await this.db
      .select()
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));
    if (questions.length === 0) return;

    const sub = (
      await this.db.select().from(subscriptions).where(eq(subscriptions.brandId, brandId)).limit(1)
    )[0];
    const accountId = sub?.accountId;
    const priority = priorityOf(sub?.plan ?? 'free');

    const round = (
      await this.db.insert(collectionRounds).values({ brandId }).returning()
    )[0]!;

    // 口径快照:轮次开始时固化的本品+已确认竞品(docs/05 §2 品牌匹配)
    const subjects = await this.db
      .select()
      .from(recognitionEntries)
      .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.confirmed, true)));
    void subjects;

    const engineList = engines.filter((e) => (WEB_ENGINES as readonly string[]).includes(e));
    const total = questions.length * engineList.length;
    let enqueued = 0;

    for (const q of questions) {
      for (const engine of engineList) {
        if (!accountId) continue;
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
      }
    }

    await this.db
      .update(collectionRounds)
      .set({ totals: { total, enqueued, done: 0, ok: 0, failed: 0 } })
      .where(eq(collectionRounds.id, round.id));
  }
}
