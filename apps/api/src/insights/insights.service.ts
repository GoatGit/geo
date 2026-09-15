import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import { industryInsights, insightIndustries } from '@geo/db';
import { INSIGHTS_QUEUE, type InsightBuildStatus } from '@geo/shared';
import type { InsightBlock, InsightCover } from '@geo/shared';
import { INSIGHT_BLOCK_TYPES } from '@geo/shared';
import { DB } from '../common/infra.module';
import { loadEnv } from '../config/env';

type InsightRow = typeof industryInsights.$inferSelect;
type IndustryRow = typeof insightIndustries.$inferSelect;

export interface UpsertInsightInput {
  industryId: number;
  issue?: string;
  title: string;
  summary?: string;
  cover?: InsightCover;
  blocks?: InsightBlock[];
  status?: 'draft' | 'published';
  featured?: boolean;
}

/** blocks 结构校验:类型合法 + 必填字段存在(管理员 JSON 编辑的守门员)。 */
export function validateBlocks(blocks: unknown): InsightBlock[] {
  if (!Array.isArray(blocks)) throw new HttpException('blocks 必须为数组', HttpStatus.BAD_REQUEST);
  for (const b of blocks) {
    const block = b as { type?: string; title?: string };
    if (!block.type || !(INSIGHT_BLOCK_TYPES as readonly string[]).includes(block.type)) {
      throw new HttpException(`未知内容块类型: ${block.type ?? '(空)'}`, HttpStatus.BAD_REQUEST);
    }
    if (typeof block.title !== 'string' || block.title.length === 0) {
      throw new HttpException(`内容块 ${block.type} 缺少 title`, HttpStatus.BAD_REQUEST);
    }
  }
  return blocks as InsightBlock[];
}

/**
 * 行业洞察(docs/01 §3.10 扩展):内容完全由管理员后台配置;
 * 会员可见已发布报告,featured 报告在官网首页公开,草稿仅后台可见。
 */
@Injectable()
export class InsightsService {
  private readonly insightsQueue = new Queue(INSIGHTS_QUEUE, {
    connection: { url: loadEnv().redisUrl, maxRetriesPerRequest: null },
  });

  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  // ===== 行业配置 =====

  async listIndustries() {
    return this.db.select().from(insightIndustries).orderBy(asc(insightIndustries.sort), asc(insightIndustries.id));
  }

  async createIndustry(name: string, sort = 0) {
    const clean = name.trim();
    if (!clean) throw new HttpException('行业名不能为空', HttpStatus.BAD_REQUEST);
    const exists = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.name, clean)).limit(1))[0];
    if (exists) throw new HttpException('行业已存在', HttpStatus.CONFLICT);
    return (await this.db.insert(insightIndustries).values({ name: clean, sort }).returning())[0]!;
  }

  async updateIndustry(id: number, patch: { name?: string; sort?: number; active?: boolean }) {
    const row = await this.db.update(insightIndustries).set(patch).where(eq(insightIndustries.id, id)).returning();
    if (row.length === 0) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    return row[0]!;
  }

  /** 删除行业:有报告时拒绝(先删报告),避免静默孤儿报告。 */
  async deleteIndustry(id: number) {
    const reports = await this.db
      .select({ id: industryInsights.id })
      .from(industryInsights)
      .where(eq(industryInsights.industryId, id))
      .limit(1);
    if (reports.length > 0) {
      throw new HttpException('该行业下已有洞察报告,请先删除报告', HttpStatus.CONFLICT);
    }
    const rows = await this.db.delete(insightIndustries).where(eq(insightIndustries.id, id)).returning({ id: insightIndustries.id });
    if (rows.length === 0) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    return { deleted: true };
  }

  /** 「运行」:对该行业最新一期报告(无则创建)入队数据聚合;聚合中拒绝重复触发。 */
  async runIndustry(industryId: number, windowDays: number | null) {
    const industry = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);

    let insight = (
      await this.db
        .select()
        .from(industryInsights)
        .where(eq(industryInsights.industryId, industryId))
        .orderBy(desc(industryInsights.updatedAt))
        .limit(1)
    )[0];
    if (!insight) {
      insight = (
        await this.db
          .insert(industryInsights)
          .values({ industryId, title: `${industry.name}行业 AI 可见度洞察` })
          .returning()
      )[0]!;
    }
    if (insight.buildStatus === 'running') {
      throw new HttpException('该行业洞察正在聚合中,请稍候', HttpStatus.CONFLICT);
    }

    await this.db
      .update(industryInsights)
      .set({ buildStatus: 'running', buildError: null, windowDays, updatedAt: new Date() })
      .where(eq(industryInsights.id, insight.id));
    await this.insightsQueue.add('build', { insightId: insight.id, windowDays }, { attempts: 1, removeOnComplete: 100 });
    return { insightId: insight.id, queued: true };
  }

  // ===== 洞察报告(管理侧)=====

  async adminList() {
    const rows = await this.db.select().from(industryInsights).orderBy(desc(industryInsights.updatedAt));
    return this.attachIndustry(rows);
  }

  async adminGet(id: number) {
    const row = (await this.db.select().from(industryInsights).where(eq(industryInsights.id, id)).limit(1))[0];
    if (!row) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    return (await this.attachIndustry([row]))[0]!;
  }

  async create(input: UpsertInsightInput) {
    validateBlocks(input.blocks ?? []);
    const row = (
      await this.db
        .insert(industryInsights)
        .values({
          industryId: input.industryId,
          issue: input.issue ?? '',
          title: input.title,
          summary: input.summary ?? '',
          cover: (input.cover ?? {}) as Record<string, unknown>,
          blocks: (input.blocks ?? []) as unknown[],
          status: input.status ?? 'draft',
          featured: input.featured ?? false,
          publishedAt: input.status === 'published' ? new Date() : null,
        })
        .returning()
    )[0]!;
    return this.adminGet(row.id);
  }

  async update(id: number, patch: Partial<UpsertInsightInput>) {
    if (patch.blocks !== undefined) validateBlocks(patch.blocks);
    const next: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ['industryId', 'issue', 'title', 'summary', 'cover', 'blocks', 'status', 'featured'] as const) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    // 发布态切换时刷新发布时间;featured 只对已发布报告生效
    if (patch.status === 'published') next.publishedAt = new Date();
    const updated = await this.db
      .update(industryInsights)
      .set(next)
      .where(eq(industryInsights.id, id))
      .returning();
    if (updated.length === 0) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    return this.adminGet(id);
  }

  async remove(id: number) {
    const rows = await this.db
      .delete(industryInsights)
      .where(eq(industryInsights.id, id))
      .returning({ id: industryInsights.id });
    if (rows.length === 0) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    return { deleted: true };
  }

  // ===== 展示侧 =====

  /** 官网首页:已发布 + 精选(公开,无需登录)。 */
  async featured() {
    const rows = await this.db
      .select()
      .from(industryInsights)
      .where(and(eq(industryInsights.status, 'published'), eq(industryInsights.featured, true)))
      .orderBy(desc(industryInsights.publishedAt))
      .limit(6);
    return this.attachIndustry(rows);
  }

  /** 会员侧:全部已发布报告。 */
  async publishedList(industryId?: number) {
    const where = industryId
      ? and(eq(industryInsights.status, 'published'), eq(industryInsights.industryId, industryId))
      : eq(industryInsights.status, 'published');
    const rows = await this.db
      .select()
      .from(industryInsights)
      .where(where)
      .orderBy(desc(industryInsights.publishedAt));
    return this.attachIndustry(rows);
  }

  /** 报告详情:已发布对全员开放(官网引流),草稿 404。 */
  async publishedDetail(id: number) {
    const row = (
      await this.db
        .select()
        .from(industryInsights)
        .where(and(eq(industryInsights.id, id), eq(industryInsights.status, 'published')))
        .limit(1)
    )[0];
    if (!row) throw new HttpException('报告不存在或未发布', HttpStatus.NOT_FOUND);
    return (await this.attachIndustry([row]))[0]!;
  }

  // ===== 内部 =====

  private async attachIndustry(rows: InsightRow[]) {
    const industries = await this.db.select().from(insightIndustries);
    const byId = new Map<number, IndustryRow>(industries.map((i) => [i.id, i]));
    return rows.map((r) => ({
      id: r.id,
      industry: byId.get(r.industryId)?.name ?? '',
      issue: r.issue,
      title: r.title,
      summary: r.summary,
      cover: r.cover as InsightCover,
      blocks: r.blocks as InsightBlock[],
      status: r.status as 'draft' | 'published',
      featured: r.featured,
      buildStatus: r.buildStatus as InsightBuildStatus,
      buildError: r.buildError,
      builtAt: r.builtAt,
      windowDays: r.windowDays,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    }));
  }
}
