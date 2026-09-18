import { Body, Controller, Delete, Get, HttpException, HttpStatus, OnModuleDestroy, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { accountProfiles, brands, collectionRounds, queryRuns } from '@geo/db';
import {
  REPORTS_QUEUE,
  REPUTATION_QUEUE,
  COLLECT_QUEUE,
  LOGIN_CANCEL_TTL_SEC,
  LOGIN_FRAME_TTL_SEC,
  LOGIN_REQ_QUEUE,
  LOGIN_STATUS_TTL_SEC,
  WEB_ENGINES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_STALE_MS,
  breakerManualKey,
  breakerTrippedKey,
  insightStatKey,
  loginCancelKey,
  loginCmdKey,
  loginFrameKey,
  loginProfileKey,
  loginStatusKey,
  type LoginInputCommand,
  type InsightAgentSettings,
  type InsightStatEvent,
  type LoginRequest,
} from '@geo/shared';
import { maskKey, testConnection } from '@geo/insight-agent';
import { loadPlatformSettings, savePlatformSettings } from '@geo/db';
import { currentAccount } from '../common/auth';
import { DB, REDIS } from '../common/infra.module';
import { loadEnv } from '../config/env';
import { AdminGuard } from './admin.guard';
import { TestInsightAgentDto, UpdateSettingsDto } from './admin.dto';

/** db.execute(QueryResult) 取行:drizzle 未知行类型的统一收口。 */
function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows;
}

/** admin 读取侧出口:apiKey 永远掩码,完整 key 不回传前端(docs/09 §4.3)。 */
export function maskInsightAgent(s: InsightAgentSettings): InsightAgentSettings {
  return { ...s, apiKey: maskKey(s.apiKey) };
}

/**
 * insightAgent 补丁合并(纯函数,便于单测):
 * apiKey 传空或传掩码形态 = 保留原值;endpoint 强制 https;
 * 启用 shadow/llm 时三项连接配置必须齐备。
 */
export function resolveInsightAgentPatch(
  current: InsightAgentSettings,
  incoming: Partial<InsightAgentSettings>,
): InsightAgentSettings {
  const merged: InsightAgentSettings = { ...current };
  if (typeof incoming.enabled === 'boolean') merged.enabled = incoming.enabled;
  if (incoming.mode === 'rules' || incoming.mode === 'shadow' || incoming.mode === 'llm') merged.mode = incoming.mode;
  if (incoming.protocol === 'openai' || incoming.protocol === 'anthropic') merged.protocol = incoming.protocol;
  if (typeof incoming.endpoint === 'string') {
    const ep = incoming.endpoint.trim();
    if (ep && !/^https:\/\//i.test(ep)) {
      throw new HttpException('Insight Agent endpoint 必须 https://', HttpStatus.BAD_REQUEST);
    }
    merged.endpoint = ep;
  }
  if (typeof incoming.model === 'string') merged.model = incoming.model.trim();
  if (typeof incoming.timeoutMs === 'number' && Number.isFinite(incoming.timeoutMs)) {
    merged.timeoutMs = Math.min(Math.max(Math.floor(incoming.timeoutMs), 2_000), 60_000);
  }
  if (typeof incoming.apiKey === 'string') {
    const key = incoming.apiKey.trim();
    // 空 = 未修改;掩码回显形态 = 未修改(前端整体回传场景的纵深防御)
    if (key && !key.startsWith('***')) merged.apiKey = key;
  }
  if (merged.enabled && merged.mode !== 'rules' && (!merged.endpoint || !merged.apiKey || !merged.model)) {
    throw new HttpException('Insight Agent 启用 shadow/llm 模式需要完整的 endpoint/apiKey/model', HttpStatus.BAD_REQUEST);
  }
  return merged;
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

  /** 档案重新可用:清除 login_required/cooldown(人工重登完成或误标记后的运营处置)。 */
  @Post('profiles/:id/recover')
  async recoverProfile(@Param('id', ParseIntPipe) id: number) {
    const row = (
      await this.db
        .update(accountProfiles)
        .set({ status: 'available', cooldownUntil: null })
        .where(eq(accountProfiles.id, id))
        .returning({ id: accountProfiles.id, engine: accountProfiles.engine, status: accountProfiles.status })
    )[0];
    if (!row) throw new HttpException('档案不存在', HttpStatus.NOT_FOUND);
    return row;
  }

  /** 删除品牌及其全部从属数据(平台运营处置;确认操作,不可逆)。 */
  @Delete('brands/:id')
  async deleteBrand(@Param('id', ParseIntPipe) id: number) {
    const brand = (
      await this.db.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.id, id)).limit(1)
    )[0];
    if (!brand) throw new HttpException('品牌不存在', HttpStatus.NOT_FOUND);

    const tables = [
      'audit_tasks',
      'mention_facts',
      'citation_facts',
      'reputation_facts',
      'query_runs',
      'daily_metrics',
      'collection_rounds',
      'collection_plans',
      'monitoring_questions',
      'recognition_entries',
      'recognition_versions',
      'competitor_candidates',
      'reports',
      'subscriptions',
    ];
    // 单事务整体删除:14 张从属表逐条裸删时,任一条中途失败(连接抖动/锁超时)
    // 都会把品牌留在"从属数据残缺但 brands 行还在"的半删态且无回滚
    const deleted: Record<string, number> = {};
    await this.db.transaction(async (tx) => {
      for (const table of tables) {
        const r = await tx.execute(
          sql.raw(`delete from ${table} where brand_id = ${id}`),
        );
        deleted[table] = r.rowCount ?? 0;
      }
      await tx.delete(brands).where(eq(brands.id, id));
    });
    return { deleted: true, brand: brand.name, rows: deleted };
  }

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

    const recentRunRows = await this.db
      .select({
        status: queryRuns.status,
        engine: queryRuns.engine,
        ranAt: queryRuns.ranAt,
        brandName: brands.name,
      })
      .from(queryRuns)
      .innerJoin(brands, eq(brands.id, queryRuns.brandId))
      .orderBy(desc(queryRuns.ranAt))
      .limit(60);

    const settings = await loadPlatformSettings(this.db);

    // Insight Agent 观测(docs/09 §10):模式 + 今日调用/降级计数(Redis 日窗,worker 侧写入)
    const insightStatEvents: InsightStatEvent[] = ['calls', 'fallback', 'invalid_partial', 'shadow_disagree'];
    let insightToday: Record<string, number> = {};
    try {
      const values = await this.redis.mget(...insightStatEvents.map((e) => insightStatKey(e)));
      insightToday = Object.fromEntries(insightStatEvents.map((e, i) => [e, Number(values[i] ?? 0)]));
    } catch {
      insightToday = {};
    }

    return {
      infra: { dbOk, redisOk, worker },
      queueCounts,
      stats: s,
      todayRuns,
      accountPool: rowsOf<{ status: string; count: number }>(pool),
      engineHealth,
      recentRuns: recentRunRows,
      settings,
      insight: {
        enabled: settings.insightAgent.enabled,
        mode: settings.insightAgent.mode,
        model: settings.insightAgent.model,
        today: insightToday,
      },
      asOf: new Date().toISOString(),
    };
  }

  @Get('settings')
  async getSettings() {
    const settings = await loadPlatformSettings(this.db);
    return { settings: { ...settings, insightAgent: maskInsightAgent(settings.insightAgent) } };
  }

  @Put('settings')
  async putSettings(@Req() req: Request, @Body() dto: UpdateSettingsDto) {
    const patch: Parameters<typeof savePlatformSettings>[1] = {};
    if (dto.schedulerEnabled !== undefined) patch.schedulerEnabled = dto.schedulerEnabled;
    if (dto.globalDailyRunCap !== undefined) patch.globalDailyRunCap = dto.globalDailyRunCap;
    if (dto.engineDailyCaps !== undefined) patch.engineDailyCaps = dto.engineDailyCaps;
    if (dto.proxyPool !== undefined) {
      const key = typeof dto.proxyPool.key === 'string' ? dto.proxyPool.key.trim() : '';
      if (dto.proxyPool.enabled && !key) {
        throw new HttpException('启用代理池必须提供青果 Key', HttpStatus.BAD_REQUEST);
      }
      patch.proxyPool = { enabled: Boolean(dto.proxyPool.enabled), key };
    }
    if (dto.insightAgent !== undefined) {
      // 基于库内当前值合并(apiKey 空/掩码 = 保留原值),而非整包覆盖
      const current = (await loadPlatformSettings(this.db)).insightAgent;
      patch.insightAgent = resolveInsightAgentPatch(current, dto.insightAgent);
    }
    const settings = await savePlatformSettings(this.db, patch, currentAccount(req).accountId);
    return { settings: { ...settings, insightAgent: maskInsightAgent(settings.insightAgent) } };
  }

  /** Insight Agent 连通性测试(docs/09 §4.3):最小补全往返,不入库。
   *  传 body.insightAgent 时用当前表单值(合并语义同保存:apiKey 空/掩码 = 用已存 key);
   *  不传则测已保存配置。测试一律忽略 enabled 开关——连通性只取决于连接三项。 */
  @Post('insight-agent/test')
  async testInsightAgent(@Body() dto: TestInsightAgentDto) {
    const saved = (await loadPlatformSettings(this.db)).insightAgent;
    const merged = dto?.insightAgent ? resolveInsightAgentPatch(saved, dto.insightAgent) : saved;
    return await testConnection({ ...merged, enabled: true });
  }

  /** 代理池实时状态:配置 + 通道/在用租约/白名单(直连青果接口;Key 未配置时仅返回配置)。 */
  @Get('proxy-pool/status')
  async proxyPoolStatus() {
    const settings = await loadPlatformSettings(this.db);
    const key = settings.proxyPool.key;
    if (!settings.proxyPool.enabled || !key) {
      return { settings: settings.proxyPool, live: null, note: '代理池未启用(仅展示配置)' };
    }
    const get = async (url: string) =>
      (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text().catch(() => '');
    const [chRaw, inuseRaw, wlRaw] = await Promise.all([
      get(`https://longterm.proxy.qg.net/channels?key=${key}&format=json`),
      get(`https://longterm.proxy.qg.net/query?key=${key}&format=json`),
      get(`https://proxy.qg.net/whitelist/query?Key=${key}&format=json`),
    ]);
    const safeParse = (t: string): Record<string, unknown> => {
      try { return JSON.parse(t) as Record<string, unknown>; } catch { return { raw: t.slice(0, 120) }; }
    };
    return {
      settings: settings.proxyPool,
      live: { channels: safeParse(chRaw), inUse: safeParse(inuseRaw), whitelist: safeParse(wlRaw) },
    };
  }

  @Get('rounds')
  async rounds(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.db
      .select({
        id: collectionRounds.id,
        brandId: collectionRounds.brandId,
        brandName: brands.name,
        startedAt: collectionRounds.startedAt,
        finishedAt: collectionRounds.finishedAt,
        totals: collectionRounds.totals,
      })
      .from(collectionRounds)
      .innerJoin(brands, eq(brands.id, collectionRounds.brandId))
      .orderBy(desc(collectionRounds.startedAt))
      .limit(n);
    return { rounds: rows };
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

  // ===== 账号池:人工登录(docs/04 §3.1 账号供给由运营完成)=====

  /** 账号池清单:按引擎分组展示状态/健康分/当日用量,后台"账号池"页消费。 */
  @Get('accounts')
  async accounts() {
    const rows = await this.db
      .select({
        id: accountProfiles.id,
        engine: accountProfiles.engine,
        surface: accountProfiles.surface,
        status: accountProfiles.status,
        healthScore: accountProfiles.healthScore,
        dailyUsed: accountProfiles.dailyUsed,
        cooldownUntil: accountProfiles.cooldownUntil,
        retiredAt: accountProfiles.retiredAt,
        createdAt: accountProfiles.createdAt,
      })
      .from(accountProfiles)
      .orderBy(accountProfiles.engine, accountProfiles.id);
    const sessions = rows.length ? await this.redis.mget(...rows.map((row) => loginProfileKey(row.id))) : [];
    return { accounts: rows.map((row, i) => ({ ...row, loginSessionId: sessions[i] ?? null })) };
  }

  /** 新建账号档案:仅登记引擎与指纹,状态 pending_login,等人工登录注入账号态。 */
  @Post('accounts')
  async createAccount(@Req() req: Request, @Body() body: { engine?: string }) {
    void currentAccount(req);
    const engine = body.engine ?? '';
    this.assertEngine(engine);
    const profile = (
      await this.db
        .insert(accountProfiles)
        .values({
          engine,
          fingerprint: {
            ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            viewport: '1366x850',
            locale: 'zh-CN',
          },
          status: 'pending_login',
        })
        .returning()
    )[0];
    return { account: profile };
  }

  /** 批量登记账号档案(账号池按批量供给运营,docs/04 §3.2);一次最多 20 个。 */
  @Post('accounts/batch')
  async createAccountsBatch(
    @Req() req: Request,
    @Body() dto: { engine?: string; count?: number },
  ) {
    void currentAccount(req);
    const engine = dto.engine ?? '';
    this.assertEngine(engine);
    const count = Math.min(Math.max(Math.floor(Number(dto.count) || 1), 1), 20);
    const created = await this.db
      .insert(accountProfiles)
      .values(
        Array.from({ length: count }, () => ({
          engine,
          fingerprint: {
            ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            viewport: '1366x850',
            locale: 'zh-CN',
          },
          status: 'pending_login',
        })),
      )
      .returning({ id: accountProfiles.id });
    return { created: created.length, ids: created.map((r) => r.id) };
  }

  /**
   * 发起人工登录:请求入 Redis 队列,worker(拥有浏览器)开出有头会话并轮询登录态。
   * 返回 sessionId 供后台轮询 GET /admin/login/:sessionId 展示进度。
   */
  @Post('accounts/:id/login')
  async requestLogin(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    void currentAccount(req);
    const profile = (await this.db.select().from(accountProfiles).where(eq(accountProfiles.id, id)).limit(1))[0];
    if (!profile) throw new NotFoundException(`账号档案不存在: ${id}`);
    if (profile.status === 'retired') throw new BadRequestException('已退役账号不可发起登录');
    this.assertEngine(profile.engine);

    const sessionId = randomUUID();
    const lockKey = loginProfileKey(profile.id);
    const claimed = await this.redis.set(lockKey, sessionId, 'EX', LOGIN_STATUS_TTL_SEC, 'NX');
    if (!claimed) {
      const existing = await this.redis.get(lockKey);
      if (existing) return { sessionId: existing, engine: profile.engine, profileId: profile.id };
      throw new ServiceUnavailableException('登录会话正在结束,请稍后重试');
    }
    const payload: LoginRequest = {
      sessionId,
      profileId: profile.id,
      engine: profile.engine,
      profileKey: `profile:${profile.id}`,
      fingerprint: profile.fingerprint,
      proxyHint: profile.proxyHint,
      contextRef: profile.contextRef,
      requestedAt: new Date().toISOString(),
    };
    try {
      if (await this.redis.llen(LOGIN_REQ_QUEUE) >= 100) throw new ServiceUnavailableException('登录队列已满,请稍后重试');
      // Remove the account from collection before making the request visible to a worker.
      const updated = await this.db.update(accountProfiles).set({ status: 'pending_login' })
        .where(and(eq(accountProfiles.id, id), eq(accountProfiles.status, profile.status)))
        .returning({ id: accountProfiles.id });
      if (!updated.length) throw new BadRequestException('账号状态已改变,请刷新后重试');
      const result = await this.redis.multi()
        .set(loginStatusKey(sessionId), JSON.stringify({ state: 'queued', updatedAt: new Date().toISOString() }), 'EX', LOGIN_STATUS_TTL_SEC)
        .rpush(LOGIN_REQ_QUEUE, JSON.stringify(payload))
        .exec();
      if (!result || result.some(([error]) => error)) throw new ServiceUnavailableException('登录请求入队失败');
    } catch (err) {
      await this.redis.set(loginCancelKey(sessionId), '1', 'EX', LOGIN_CANCEL_TTL_SEC);
      await this.redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0', 1, lockKey, sessionId);
      throw err;
    }
    return { sessionId, engine: profile.engine, profileId: profile.id };
  }

  /** 登录会话状态轮询(queued/running/done/timeout/error/cancelled;viewer=true 时展示实时画面)。 */
  @Get('login/:sessionId')
  async loginStatus(@Param('sessionId') sessionId: string) {
    const raw = await this.redis.get(loginStatusKey(sessionId));
    if (!raw) throw new NotFoundException('登录会话不存在或已过期');
    return JSON.parse(raw) as { state: string; detail?: string; viewer?: boolean; updatedAt: string };
  }

  /**
   * 取消登录:置取消标记,worker 轮询循环发现即终止并释放远程会话。
   * 失败/挂起的登录不必等满超时窗口,避免占住并发槽阻塞其他账号排队。
   */
  @Post('login/:sessionId/cancel')
  async cancelLogin(@Req() req: Request, @Param('sessionId') sessionId: string) {
    void currentAccount(req);
    const raw = await this.redis.get(loginStatusKey(sessionId));
    if (!raw) throw new NotFoundException('登录会话不存在或已过期');
    await this.redis.set(loginCancelKey(sessionId), '1', 'EX', LOGIN_CANCEL_TTL_SEC);
    return { cancelled: true };
  }

  /** viewer 模式最新截帧(JPEG base64;viewerLoginFromEnv 的远程登录画面)。 */
  @Get('login/:sessionId/frame')
  async loginFrame(@Param('sessionId') sessionId: string) {
    const frame = await this.redis.get(loginFrameKey(sessionId));
    return { frame };
  }

  /** viewer 模式输入转发:点击/文字/回车 → worker 经 CDP 注入远程页面。 */
  @Post('login/:sessionId/input')
  async loginInput(
    @Param('sessionId') sessionId: string,
    @Body() cmd: { type?: string; x?: number; y?: number; toX?: number; toY?: number; deltaY?: number; text?: string; key?: string },
  ) {
    const raw = await this.redis.get(loginStatusKey(sessionId));
    if (!raw) throw new NotFoundException('登录会话不存在或已过期');
    const status = JSON.parse(raw);
    if (status.state !== 'running' || !status.viewer) throw new BadRequestException('登录会话当前不可操作');
    const coordinate = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) {
        throw new BadRequestException('无效的画面坐标');
      }
      return Math.floor(value);
    };
    let input: LoginInputCommand;
    if (cmd.type === 'click' || cmd.type === 'drag') {
      const x = coordinate(cmd.x);
      const y = coordinate(cmd.y);
      input = cmd.type === 'click' ? { type: 'click', x, y }
        : { type: 'drag', x, y, toX: coordinate(cmd.toX), toY: coordinate(cmd.toY) };
    } else if (cmd.type === 'scroll') {
      if (typeof cmd.deltaY !== 'number' || !Number.isFinite(cmd.deltaY)) throw new BadRequestException('无效的滚动距离');
      input = { type: 'scroll', deltaY: Math.max(-2_000, Math.min(2_000, cmd.deltaY)) };
    } else if (cmd.type === 'type') {
      const text = String(cmd.text ?? '').slice(0, 200);
      if (!text) throw new BadRequestException('输入文字不能为空');
      input = { type: 'type', text };
    } else if (cmd.type === 'key') {
      const key = String(cmd.key ?? '');
      if (!/^[a-zA-Z0-9]$/.test(key) && !['Enter', 'Backspace', 'Escape', 'Tab', 'ControlOrMeta+A'].includes(key)) throw new BadRequestException('不支持的按键');
      input = { type: 'key', key };
    } else {
      throw new BadRequestException('未知指令类型');
    }
    await this.redis.rpush(loginCmdKey(sessionId), JSON.stringify(input));
    await this.redis.expire(loginCmdKey(sessionId), LOGIN_FRAME_TTL_SEC);
    return { ok: true };
  }

  @Post('accounts/:id/disable')
  async disableAccount(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    void currentAccount(req);
    const sessionId = await this.redis.get(loginProfileKey(id));
    if (sessionId) await this.redis.set(loginCancelKey(sessionId), '1', 'EX', LOGIN_CANCEL_TTL_SEC);
    await this.db
      .update(accountProfiles)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(accountProfiles.id, id));
    return { id, status: 'retired' };
  }

  @Post('accounts/:id/enable')
  async enableAccount(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    void currentAccount(req);
    await this.db
      .update(accountProfiles)
      .set({ status: 'pending_login', cooldownUntil: null, retiredAt: null })
      .where(eq(accountProfiles.id, id));
    return { id, status: 'pending_login' };
  }

  private assertEngine(engine: string) {
    if (!(WEB_ENGINES as readonly string[]).includes(engine)) throw new BadRequestException(`未知引擎: ${engine}`);
    if (!this.redis.status || this.redis.status === 'end') {
      throw new ServiceUnavailableException('Redis 不可用,无法操作熔断位');
    }
  }
}
