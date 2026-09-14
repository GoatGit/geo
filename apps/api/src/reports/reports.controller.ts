import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REPORT_TYPES, type ReportType } from '@geo/shared';
import { reports } from '@geo/db';
import { createStorageFromEnv, type EvidenceStorage } from '@geo/evidence';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';
import { ReportRenderService } from './render.service';

@Controller('reports')
export class ReportsController {
  private readonly queue: Queue;
  private readonly storage: EvidenceStorage = createStorageFromEnv();

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) redis: Redis,
    private readonly brandsService: BrandsService,
    private readonly renderer: ReportRenderService,
  ) {
    this.queue = new Queue('reports', { connection: this.connOptions(redis) });
  }

  @Get()
  async list() {
    return this.db.select().from(reports).orderBy(desc(reports.createdAt)).limit(50);
  }

  @Get('templates')
  templates() {
    return this.renderer.templates();
  }

  /** 手动触发生成(docs/05 §6);周/月报另由 worker cron 自动生成。 */
  @Post('generate')
  async generate(@Req() req: Request, @Body() body: { brandId?: number; type?: string }) {
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

  /** 卡住的报告重新入队(排队中超时或失败)。 */
  @Post(':id/retry')
  async retry(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const row = await this.ownedRow(req, id);
    if (row.status === 'done') throw new HttpException('报告已完成,无需重试', HttpStatus.BAD_REQUEST);
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
    void redis;
    return { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null };
  }
}
