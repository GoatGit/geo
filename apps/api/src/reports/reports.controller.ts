import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Queue } from 'bullmq';
import { reports } from '@geo/db';
import { REPORT_TYPES, type ReportType } from '@geo/shared';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';

@Controller('reports')
export class ReportsController {
  private readonly queue: Queue;

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) redis: Redis,
    private readonly brandsService: BrandsService,
  ) {
    this.queue = new Queue('reports', { connection: this.connOptions(redis) });
  }

  @Get()
  async list(@Req() req: Request) {
    void req;
    return this.db.select().from(reports).orderBy(desc(reports.createdAt)).limit(50);
  }

  /** 手动触发生成(docs/05 §6);周/月报另由 worker cron 自动生成。 */
  @Post('generate')
  async generate(
    @Req() req: Request,
    @Body() body: { brandId?: number; type?: string },
  ) {
    const type = body?.type ?? '';
    if (!REPORT_TYPES.includes(type as ReportType)) {
      throw new HttpException(`unknown report type: ${type}`, HttpStatus.BAD_REQUEST);
    }
    const brandId = Number(body?.brandId);
    if (!brandId) throw new HttpException('brandId is required', HttpStatus.BAD_REQUEST);
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);

    const period = new Date().toISOString().slice(0, 10);
    const row = (
      await this.db.insert(reports).values({ brandId, type: type as ReportType, period }).returning()
    )[0]!;
    await this.queue.add('generate', { reportId: row.id, brandId, type, period }, { attempts: 3 });
    return row;
  }

  private connOptions(redis: Redis) {
    // BullMQ 复用同一 Redis;SAE 内网地址经 REDIS_URL 注入
    void redis;
    return {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    };
  }
}
