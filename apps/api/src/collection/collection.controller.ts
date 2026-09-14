import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { collectionPlans, collectionRounds, queryRuns } from '@geo/db';
import { WEB_ENGINES, breakerManualKey, breakerTrippedKey } from '@geo/shared';
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
}
