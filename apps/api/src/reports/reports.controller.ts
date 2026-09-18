import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  OnModuleDestroy,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { IsIn, IsInt } from 'class-validator';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REPORT_TYPES, PLAN_LIMITS, PLAN_LABELS, type ReportType } from '@geo/shared';
import { brands, reports } from '@geo/db';
import { createStorageFromEnv, type EvidenceStorage } from '@geo/evidence';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';
import { BillingService } from '../billing/billing.service';
import { ReportRenderService } from './render.service';
import { loadEnv } from '../config/env';

class GenerateReportDto {
  @IsInt()
  brandId!: number;

  @IsIn(REPORT_TYPES as unknown as string[])
  type!: ReportType;
}

@Controller('reports')
export class ReportsController implements OnModuleDestroy {
  private readonly queue: Queue;
  private readonly storage: EvidenceStorage = createStorageFromEnv();

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) redis: Redis,
    private readonly brandsService: BrandsService,
    private readonly billing: BillingService,
    private readonly renderer: ReportRenderService,
  ) {
    this.queue = new Queue('reports', { connection: this.connOptions(redis) });
  }

  async onModuleDestroy() {
    await this.queue.close().catch(() => undefined);
  }

  /** 仅返回本人品牌下的报告(跨租户隔离;admin 走平台后台总览)。 */
  @Get()
  async list(@Req() req: Request) {
    const accountId = currentAccount(req).accountId;
    const owned = await this.db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.accountId, accountId));
    const ids = owned.map((b) => b.id);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(reports)
      .where(inArray(reports.brandId, ids))
      .orderBy(desc(reports.createdAt))
      .limit(50);
  }

  @Get('templates')
  templates() {
    return this.renderer.templates();
  }

  /** 手动触发生成(docs/05 §6);周/月报另由 worker cron 自动生成。套餐门控 + 当日频控。 */
  @Post('generate')
  async generate(@Req() req: Request, @Body() dto: GenerateReportDto) {
    const account = currentAccount(req);
    const type = dto.type;
    await this.brandsService.getOwned(account.accountId, dto.brandId);

    // 套餐门控(docs/01 §3.10):free 档无周报/月报;诊断报告所有档位可用
    const membership = await this.billing.accountMembership(account.accountId);
    const limits = PLAN_LIMITS[membership.plan] ?? PLAN_LIMITS.free;
    const gated = type === 'weekly' ? limits.weeklyReport : type === 'monthly' ? limits.monthlyReport : true;
    if (!gated) {
      throw new HttpException(`${PLAN_LABELS[membership.plan]}不包含${type === 'weekly' ? '周报' : '月报'},升级套餐解锁`, HttpStatus.FORBIDDEN);
    }

    // 同品牌同类型当天已有排队/生成中的任务则拒绝重复下单(防双击与滥用)
    const inflight = await this.db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.brandId, dto.brandId),
          eq(reports.type, type),
          inArray(reports.status, ['queued', 'generating']),
          gte(reports.createdAt, new Date(Date.now() - 24 * 3600 * 1000)),
        ),
      )
      .limit(1);
    if (inflight.length > 0) {
      throw new HttpException('该报告正在生成中,请稍候', HttpStatus.CONFLICT);
    }

    const period = new Date().toISOString().slice(0, 10);
    const row = (
      await this.db.insert(reports).values({ brandId: dto.brandId, type, period }).returning()
    )[0]!;
    await this.queue.add('generate', { reportId: row.id, brandId: dto.brandId, type, period }, { attempts: 3 });
    return row;
  }

  /** 卡住的报告重新入队(失败,或长时间停留在排队/生成中的卡死任务)。 */
  @Post(':id/retry')
  async retry(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const row = await this.ownedRow(req, id);
    if (row.status === 'done') throw new HttpException('报告已完成,无需重试', HttpStatus.BAD_REQUEST);
    // 频控:queued/generating 可被反复重新入队刷队列(每次 attempts:3)。
    // failed 直接可重试;在途状态只允许"卡死 30 分钟以上"的旧任务重试
    const stale =
      row.status === 'queued' || row.status === 'generating'
        ? Date.now() - row.createdAt.getTime() > 30 * 60_000
        : false;
    if (row.status !== 'failed' && !stale) {
      throw new HttpException('报告正在生成中,请稍候(卡死超 30 分钟可重试)', HttpStatus.CONFLICT);
    }
    await this.db.update(reports).set({ status: 'queued' }).where(eq(reports.id, id));
    await this.queue.add(
      'generate',
      { reportId: id, brandId: row.brandId, type: row.type, period: row.period },
      { attempts: 3 },
    );
    return { retried: true };
  }

  /** 在线预览:按模板渲染为自包含 HTML,前端 iframe srcDoc 展示。 */
  @Get(':id/preview')
  async preview(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const { row, payload } = await this.loadPayload(req, id);
    const html = this.renderer.render(payload, row.type as ReportType);
    return { id, type: row.type, period: row.period, html };
  }

  /** 下载:同模板 HTML 作为附件(浏览器打印即可得 PDF,docs/01 §3.8)。 */
  @Get(':id/download')
  async download(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const { row, payload } = await this.loadPayload(req, id);
    const html = this.renderer.render(payload, row.type as ReportType);
    const name = `青柠GEO-${row.type}-${row.period}-${id}.html`;
    return {
      filename: name,
      contentBase64: Buffer.from(html, 'utf8').toString('base64'),
      contentType: 'text/html; charset=utf-8',
    };
  }

  private async ownedRow(req: Request, id: number) {
    const row = (await this.db.select().from(reports).where(eq(reports.id, id)).limit(1))[0];
    if (!row) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    await this.brandsService.getOwned(currentAccount(req).accountId, row.brandId);
    return row;
  }

  private async loadPayload(req: Request, id: number) {
    const row = await this.ownedRow(req, id);
    if (row.status !== 'done' || !row.payloadRef) {
      throw new HttpException('报告尚未生成完成(排队中/失败可重试)', HttpStatus.CONFLICT);
    }
    let payload: Record<string, unknown>;
    try {
      const raw = await this.storage.get(row.payloadRef);
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpException('报告产物缺失,请重试生成', HttpStatus.CONFLICT);
    }
    return { row, payload: payload as never };
  }

  private connOptions(redis: Redis) {
    // Redis 只用于取连接配置;URL 以集中 env 配置为单一事实源
    void redis;
    return { url: loadEnv().redisUrl, maxRetriesPerRequest: null };
  }
}
