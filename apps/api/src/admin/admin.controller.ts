import { Body, Controller, Get, OnModuleDestroy, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  REPORTS_QUEUE,
  REPUTATION_QUEUE,
  COLLECT_QUEUE,
  WEB_ENGINES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_STALE_MS,
  breakerManualKey,
  breakerTrippedKey,
} from '@geo/shared';
import { loadPlatformSettings, savePlatformSettings } from '@geo/db';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { loadEnv } from '../config/env';
import { AdminGuard } from './admin.guard';
import { UpdateSettingsDto } from './admin.dto';

/** db.execute(QueryResult) 取行:drizzle 未知行类型的统一收口。 */
function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows;
}

/**
 * 平台管理后台(docs/03 §4 RBAC 的平台侧落地):
 * 系统总览(基础设施/队列/账号池/今日任务)、全局采集配置、跨品牌轮次、引擎手动熔断。
 * 全部端点仅 role=admin 可达。
 */
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController implements OnModuleDestroy {
  /** API 侧只读队列视图:取计数,不消费任务。 */
  private readonly queues = [COLLECT_QUEUE, REPUTATION_QUEUE, REPORTS_QUEUE].map((name) =>
    new Queue(name, { connection: { url: loadEnv().redisUrl, maxRetriesPerRequest: null } }),
  );

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleDestroy() {
    await Promise.allSettled(this.queues.map((q) => q.close()));
  }

  @Get('overview')
  async overview(@Req() req: Request) {
    void currentAccount(req);

    const [dbOk, redisOk] = await Promise.all([
      this.db
        .execute(sql`select 1 as ok`)
        .then(() => true)
        .catch(() => false),
      this.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    // 调度器心跳(每 tick 覆写;超窗视为离线)
    let worker: { online: boolean; lastBeatAt: string | null; concurrency: number | null };
    try {
      const raw = await this.redis.get(WORKER_HEARTBEAT_KEY);
      const beat = raw ? (JSON.parse(raw) as { ts: number; concurrency?: number }) : null;
      worker = {
        online: !!beat && Date.now() - beat.ts < WORKER_HEARTBEAT_STALE_MS,
        lastBeatAt: beat ? new Date(beat.ts).toISOString() : null,
        concurrency: beat?.concurrency ?? null,
      };
    } catch {
      worker = { online: false, lastBeatAt: null, concurrency: null };
    }

    const queueCounts = [];
    for (const q of this.queues) {
      try {
        queueCounts.push({ name: q.name, ...(await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')) });
      } catch {
        queueCounts.push({ name: q.name, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 });
      }
    }

    const stats = await this.db.execute(sql`
      select
        (select count(*) from brands)::int as brands,
        (select count(*) from accounts)::int as accounts,
        (select count(*) from collection_plans where active)::int as active_plans,
        (select count(*) from monitoring_questions where status = 'active')::int as active_questions,
        (select count(*) from collection_rounds where finished_at is null)::int as rounds_running,
        (select count(*) from query_runs where ran_at >= date_trunc('day', now()))::int as runs_today
    `);
    const s = rowsOf<Record<string, number>>(stats)[0] ?? {};

    const byStatus = await this.db.execute(sql`
      select status, count(*)::int as count
      from query_runs
      where ran_at >= date_trunc('day', now())
      group by status
    `);
    const todayRuns: Record<string, number> = {};
    for (const r of rowsOf<{ status: string; count: number }>(byStatus)) todayRuns[r.status] = r.count;

    const pool = await this.db.execute(sql`
      select status, count(*)::int as count from account_profiles group by status
    `);

    const engines = await this.db.execute(sql`
      select engine, status, count(*)::int as count
      from query_runs
      where ran_at >= now() - interval '24 hours'
      group by engine, status
    `);
    const engineRows = rowsOf<{ engine: string; status: string; count: number }>(engines);
    const engineHealth = [];
    for (const engine of WEB_ENGINES) {
      const rs = engineRows.filter((r) => r.engine === engine);
      const ok = rs.filter((r) => r.status === 'ok_with_answer' || r.status === 'ok_empty').reduce((a, r) => a + r.count, 0);
      const failed = rs.filter((r) => r.status === 'failed').reduce((a, r) => a + r.count, 0);
      const total = rs.reduce((a, r) => a + r.count, 0);
      engineHealth.push({
        engine,
        ok,
        failed,
        total,
        successRate: total > 0 ? Math.round((ok / total) * 1000) / 1000 : null,
        tripped: (await this.redis.get(breakerTrippedKey(engine))) === '1',
        manuallyPaused: (await this.redis.get(breakerManualKey(engine))) === '1',
      });
    }

    const recentRuns = await this.db.execute(sql`
      select r.status, r.engine, r.ran_at as "ranAt", b.name as "brandName"
      from query_runs r
      join brands b on b.id = r.brand_id
      order by r.ran_at desc
      limit 60
    `);

    const settings = await loadPlatformSettings(this.db);

    return {
      infra: { dbOk, redisOk, worker },
      queueCounts,
      stats: s,
      todayRuns,
      accountPool: rowsOf<{ status: string; count: number }>(pool),
      engineHealth,
      recentRuns: rowsOf<{ status: string; engine: string; ranAt: string; brandName: string }>(recentRuns),
      settings,
      asOf: new Date().toISOString(),
    };
  }

  @Get('settings')
  async getSettings() {
    return { settings: await loadPlatformSettings(this.db) };
  }

  @Put('settings')
  async putSettings(@Req() req: Request, @Body() dto: UpdateSettingsDto) {
    const patch: Parameters<typeof savePlatformSettings>[1] = {};
    if (dto.schedulerEnabled !== undefined) patch.schedulerEnabled = dto.schedulerEnabled;
    if (dto.globalDailyRunCap !== undefined) patch.globalDailyRunCap = dto.globalDailyRunCap;
    if (dto.engineDailyCaps !== undefined) patch.engineDailyCaps = dto.engineDailyCaps;
    const settings = await savePlatformSettings(this.db, patch, currentAccount(req).accountId);
    return { settings };
  }

  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.db.execute(sql`
      select cr.id, cr.brand_id as "brandId", b.name as "brandName", cr.started_at as "startedAt",
             cr.finished_at as "finishedAt", cr.totals
      from collection_rounds cr
      join brands b on b.id = cr.brand_id
      order by cr.started_at desc
      limit ${n}
    `);
    return { rounds: rowsOf<Record<string, unknown>>(rows) };
  }

  /** 手动暂停引擎(与自动熔断独立:manual 位不过期,自动位保持 5 分钟半开节奏)。 */
  @Post('engines/:engine/pause')
  async pauseEngine(@Req() req: Request, @Param('engine') engine: string) {
    void currentAccount(req);
    this.assertEngine(engine);
    await this.redis.set(breakerManualKey(engine), '1');
    return { engine, manuallyPaused: true };
  }

  @Post('engines/:engine/resume')
  async resumeEngine(@Req() req: Request, @Param('engine') engine: string) {
    void currentAccount(req);
    this.assertEngine(engine);
    // 恢复时同时清自动熔断位,避免立即被半开窗口重新拦下
    await this.redis.del(breakerManualKey(engine), breakerTrippedKey(engine));
    return { engine, manuallyPaused: false };
  }

  private assertEngine(engine: string) {
    if (!(WEB_ENGINES as readonly string[]).includes(engine)) throw new NotFoundException(`未知引擎: ${engine}`);
    if (!this.redis.status || this.redis.status === 'end') {
      throw new ServiceUnavailableException('Redis 不可用,无法操作熔断位');
    }
  }
}
