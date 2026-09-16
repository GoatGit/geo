import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Req } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { collectionPlans, collectionRounds, monitoringQuestions, queryRuns, subscriptions } from '@geo/db';
import { WEB_ENGINES, breakerManualKey, breakerTrippedKey } from '@geo/shared';
import { Queue } from 'bullmq';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';

/**
 * 采集状态页(docs/01 IA ④):引擎覆盖 / 轮次健康 / 熔断状态 / 配额用量。
 * "透明可信"定位的可见性锚点:队列与账号池健康度对用户可见。
 */
@Controller('collection')
export class CollectionController {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly brandsService: BrandsService,
  ) {}

  @Get('status')
  async status(@Req() req: Request, @Query('brand') brand: string) {
    const brandId = Number(brand);
    if (!Number.isInteger(brandId) || brandId <= 0) {
      throw new HttpException('brand 参数非法', HttpStatus.BAD_REQUEST);
    }
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);

    const plan = (
      await this.db.select().from(collectionPlans).where(eq(collectionPlans.brandId, brandId)).limit(1)
    )[0];

    const rounds = await this.db
      .select()
      .from(collectionRounds)
      .where(eq(collectionRounds.brandId, brandId))
      .orderBy(desc(collectionRounds.startedAt))
      .limit(10);

    const recent = await this.db
      .select({
        status: queryRuns.status,
        engine: queryRuns.engine,
        ranAt: queryRuns.ranAt,
      })
      .from(queryRuns)
      .where(eq(queryRuns.brandId, brandId))
      .orderBy(desc(queryRuns.ranAt))
      .limit(500);

    const byEngine = [];
    for (const engine of WEB_ENGINES) {
      const rs = recent.filter((r) => r.engine === engine);
      const ok = rs.filter((r) => r.status === 'ok_with_answer' || r.status === 'ok_empty').length;
      const failed = rs.filter((r) => r.status === 'failed').length;
      byEngine.push({
        engine,
        paused:
          (await this.redis.get(breakerTrippedKey(engine))) === '1' ||
          (await this.redis.get(breakerManualKey(engine))) === '1',
        recent: rs.length,
        ok,
        failed,
        successRate: rs.length > 0 ? Math.round((ok / rs.length) * 1000) / 1000 : null,
      });
    }

    return {
      plan: plan
        ? { engines: plan.engines, surfaces: plan.surfaces, freq: plan.freq, nextRunAt: plan.nextRunAt, active: plan.active }
        : null,
      engines: byEngine,
      rounds,
      lastRuns: recent.slice(0, 50),
    };
  }

  /** 重试轮次失败项(docs/02 §1.1 四态失败可见可处置):封装为新轮次入队,幂等防连点。 */
  @Post('retry-failed')
  async retryFailed(
    @Req() req: Request,
    @Body() body: { brand?: number; roundId?: number },
  ) {
    const brandId = Number(body?.brand);
    const roundId = Number(body?.roundId);
    if (!Number.isInteger(brandId) || brandId <= 0 || !Number.isInteger(roundId) || roundId <= 0) {
      throw new HttpException('brand/roundId 参数非法', HttpStatus.BAD_REQUEST);
    }
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);

    // 防连点:同轮次 60s 内只允许一次重试入队
    const lock = await this.redis.set(`geo:retry:${roundId}`, '1', 'EX', 60, 'NX');
    if (lock !== 'OK') {
      throw new HttpException('该轮次的重试刚已提交,请稍候刷新查看', HttpStatus.CONFLICT);
    }

    const round = (
      await this.db
        .select()
        .from(collectionRounds)
        .where(and(eq(collectionRounds.id, roundId), eq(collectionRounds.brandId, brandId)))
        .limit(1)
    )[0];
    if (!round) throw new HttpException('轮次不存在', HttpStatus.NOT_FOUND);
    if (!round.finishedAt) throw new HttpException('轮次仍在进行中,完成后才能重试失败项', HttpStatus.CONFLICT);

    // 只重试「失败」且问题仍处于启用状态的项;失败/拦截本就不计入指标分母,重试不破坏口径
    const failedRuns = await this.db
      .select({
        engine: queryRuns.engine,
        questionId: queryRuns.questionId,
        text: monitoringQuestions.textExpanded,
        type: monitoringQuestions.type,
      })
      .from(queryRuns)
      .innerJoin(monitoringQuestions, eq(queryRuns.questionId, monitoringQuestions.id))
      .where(
        and(
          eq(queryRuns.roundId, roundId),
          inArray(queryRuns.status, ['failed', 'quota_blocked']),
          eq(monitoringQuestions.status, 'active'),
        ),
      );
    if (failedRuns.length === 0) {
      return { retried: 0, note: '本轮没有失败/被拦截项' };
    }

    const plan = (
      await this.db.select().from(collectionPlans).where(eq(collectionPlans.brandId, brandId)).limit(1)
    )[0];
    if (!plan?.active) throw new HttpException('采集计划已停用,无法重试', HttpStatus.CONFLICT);

    const sub = (
      await this.db.select().from(subscriptions).where(eq(subscriptions.brandId, brandId)).limit(1)
    )[0];
    const priority = this.priorityOf(sub?.plan ?? 'free');

    const newRound = (
      await this.db
        .insert(collectionRounds)
        .values({
          brandId,
          totals: { total: failedRuns.length, enqueued: failedRuns.length, done: 0, ok: 0, failed: 0 },
        })
        .returning({ id: collectionRounds.id })
    )[0]!;

    // 与 worker 的 CollectJobData 同构(docs/04 §5);优先级随套餐
    const queue = new Queue('collect', {
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
    });
    try {
      for (const f of failedRuns) {
        await queue.add(
          'collect',
          {
            runId: 0,
            brandId,
            accountId: currentAccount(req).accountId,
            roundId: newRound.id,
            questionId: f.questionId,
            questionType: f.type as 'ranking' | 'reputation',
            questionText: f.text,
            engine: f.engine,
            surface: 'web' as const,
            priority,
          },
          { priority },
        );
      }
    } finally {
      await queue.close();
    }

    return { retried: failedRuns.length, roundId: newRound.id };
  }

  /** BullMQ 优先级:数值越大越优先(与 worker 侧 priorityOf 同口径)。 */
  private priorityOf(plan: string): number {
    switch (plan) {
      case 'custom':
        return 50;
      case 'pro':
        return 40;
      case 'standard':
        return 30;
      case 'starter':
        return 20;
      default:
        return 10;
    }
  }
}
