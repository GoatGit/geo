import { HttpException, HttpStatus, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import { industryInsights, insightIndustries, brands, monitoringQuestions, loadPlatformSettings } from '@geo/db';
import { chatCompletion } from '@geo/insight-agent';
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
export class InsightsService implements OnModuleDestroy {
  private readonly insightsQueue = new Queue(INSIGHTS_QUEUE, {
    connection: { url: loadEnv().redisUrl, maxRetriesPerRequest: null },
  });

  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  async onModuleDestroy() {
    await this.insightsQueue.close().catch(() => undefined);
  }

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

  // ===== 向导步骤②:监测品牌(AI 推荐 + 人工补充) =====

  /** 该行业现有监测品牌(含问题数与近 7 天有效回答,供向导呈现)。 */
  async listIndustryBrands(industryId: number) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const res = await this.db.execute(sql`
      select b.id::bigint as id, b.name, b.status,
             (select count(*) from monitoring_questions q where q.brand_id = b.id and q.status = 'active')::int as questions,
             (select count(*) from query_runs r where r.brand_id = b.id
                and r.ran_at > now() - interval '7 days'
                and r.status in ('ok_with_answer','ok_empty'))::int as recent_answers
      from brands b
      where b.industry = ${industry.name} and b.status = 'active'
      order by b.id
    `);
    // node-postgres Result 直接返回会整体序列化(command/fields 等元数据混入),取 rows
    return (res as unknown as { rows: unknown[] }).rows;
  }

  /** AI 推荐行业监测品牌:LLM 产出 5-8 个头部品牌的建号描述(名称/官网/定位/竞品)。 */
  async suggestIndustryBrands(industryId: number) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
      throw new HttpException('需先在「全局配置 → Insight Agent」启用 LLM', HttpStatus.BAD_REQUEST);
    }
    const existing = await this.db.select({ name: brands.name }).from(brands).where(and(eq(brands.industry, industry.name), eq(brands.status, 'active')));

    const system =
      '你是行业研究员。为"AI 搜索品牌可见度监测"挑选值得监测的行业品牌。只输出一个 JSON 对象。' +
      'schema: {"brands":[{"name":"品牌名(2-12字)","website":"官网域名(没有则空串)","description":"品牌叫X,行业{industry},官网 https://…。X是…(定位/核心产品线/卖点,60-120字),主要竞品是A、B、C。目标客群…"}]}。' +
      '要求:5-8 个该行业真实存在的头部+成长期品牌(消费者在 AI 里会问到的);description 用"品牌叫X,行业Y"开头(建号解析依赖此格式);覆盖不同定位梯队;避开已监测品牌。';
    const raw = await chatCompletion(
      { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
      { system, user: JSON.stringify({ 行业: industry.name, 已监测: existing.map((b) => b.name) }), maxTokens: 1600 },
    );
    const m = raw.text.match(/\{[\s\S]*\}/);
    if (!m) throw new HttpException('AI 返回格式异常,请重试', HttpStatus.BAD_GATEWAY);
    const parsed = JSON.parse(m[0]) as { brands?: Array<{ name?: string; website?: string; description?: string }> };
    const suggestions = (parsed.brands ?? [])
      .map((b) => ({ name: String(b.name ?? '').trim(), website: String(b.website ?? '').trim(), description: String(b.description ?? '').trim() }))
      .filter((b) => b.name.length >= 2 && b.description.length >= 30 && !existing.some((e) => e.name === b.name))
      .slice(0, 8);
    if (suggestions.length === 0) throw new HttpException('AI 未给出有效品牌建议,请重试', HttpStatus.BAD_GATEWAY);
    return { industry: industry.name, suggestions };
  }

  // ===== 向导步骤③:行业问题(聚合呈现 + AI 生成 + 人工增删) =====

  /** 行业问题聚合视图:按题面去重(行业问题会同时挂在多个品牌下),含覆盖品牌数。 */
  async listIndustryQuestions(industryId: number) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const res = await this.db.execute(sql`
      select q.text_raw as text, max(q.type) as type,
             count(distinct q.brand_id)::int as brands,
             min(q.id)::bigint as first_id
      from monitoring_questions q
      join brands b on b.id = q.brand_id
      where b.industry = ${industry.name} and b.status = 'active' and q.status = 'active'
      group by q.text_raw
      order by min(q.id)
    `);
    return (res as unknown as { rows: unknown[] }).rows;
  }

  /** 手动新增行业问题:同时挂到该行业全部品牌(与 AI 下发一致)。 */
  async addIndustryQuestion(industryId: number, text: string, type: 'ranking' | 'reputation') {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const clean = text.trim();
    if (clean.length < 8 || clean.length > 60) throw new HttpException('问题长度需在 8-60 字', HttpStatus.BAD_REQUEST);
    const targets = await this.db.select({ id: brands.id }).from(brands).where(and(eq(brands.industry, industry.name), eq(brands.status, 'active')));
    if (targets.length === 0) throw new HttpException('该行业还没有监测品牌', HttpStatus.BAD_REQUEST);
    for (const b of targets) {
      await this.db.insert(monitoringQuestions).values({ brandId: b.id, textRaw: clean, textExpanded: clean, type, status: 'active' });
    }
    return { added: clean, brands: targets.length };
  }

  /** 删除行业问题:按题面在该行业全部品牌下同步删除(行业级对称)。 */
  async removeIndustryQuestion(industryId: number, text: string) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const res = await this.db.execute(sql`
      delete from monitoring_questions q
      using brands b
      where q.brand_id = b.id and b.industry = ${industry.name} and q.text_raw = ${text}
      returning q.id
    `);
    return { deleted: res.rowCount ?? 0 };
  }

  /**
   * 行业级监测问题生成器(市场化的关键一步):LLM 按行业生成"能产出多品牌声场"的
   * 行业问题(格局/品类对比/口碑),一键下发到该行业全部品牌。apply=false 只返回建议。
   */
  async suggestIndustryQuestions(industryId: number, apply: boolean) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
      throw new HttpException('需先在「全局配置 → Insight Agent」启用 LLM', HttpStatus.BAD_REQUEST);
    }
    const brandRows = await this.db.select({ name: brands.name }).from(brands).where(and(eq(brands.industry, industry.name), eq(brands.status, 'active')));
    if (brandRows.length === 0) throw new HttpException('该行业还没有监测品牌,请先创建', HttpStatus.BAD_REQUEST);

    const system =
      '你是市场调研专家,为"AI 搜索品牌可见度监测"设计行业级监控问题。只输出一个 JSON 对象。' +
      'schema: {"questions":[{"type":"ranking|reputation","text":"问题(15-35字,自然口语,像真实用户问 AI)"}]}。' +
      '要求:8 个问题,覆盖 ①行业格局(如「XX行业品牌排行榜前十」) ②品类选购对比 ③头部品牌对比 ④口碑与投诉;ranking 与 reputation 约各半;' +
      '问题必须是"行业视角"而非单一品牌视角——答案里自然出现多个品牌,才能聚合出行业声场。';
    const raw = await chatCompletion(
      { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
      { system, user: JSON.stringify({ 行业: industry.name, 已监测品牌: brandRows.map((b) => b.name) }), maxTokens: 900 },
    );
    const m = raw.text.match(/\{[\s\S]*\}/);
    if (!m) throw new HttpException('AI 返回格式异常,请重试', HttpStatus.BAD_GATEWAY);
    const parsed = JSON.parse(m[0]) as { questions?: Array<{ type?: string; text?: string }> };
    const questions = (parsed.questions ?? [])
      .map((q) => ({ type: q.type === 'reputation' ? ('reputation' as const) : ('ranking' as const), text: String(q.text ?? '').trim() }))
      .filter((q) => q.text.length >= 8 && q.text.length <= 60)
      .slice(0, 8);
    if (questions.length < 3) throw new HttpException('AI 生成的问题过少,请重试', HttpStatus.BAD_GATEWAY);

    let inserted = 0;
    if (apply) {
      const targets = await this.db.select({ id: brands.id }).from(brands).where(and(eq(brands.industry, industry.name), eq(brands.status, 'active')));
      for (const b of targets) {
        for (const q of questions) {
          await this.db.insert(monitoringQuestions).values({
            brandId: b.id,
            textRaw: q.text,
            textExpanded: q.text,
            type: q.type,
            status: 'active',
          });
          inserted++;
        }
      }
    }
    return { industry: industry.name, questions, applied: apply, inserted };
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

    // 原子占位:running 且租约未过期(10 分钟)时拒绝;worker 崩溃留下的 running
    // 超过租约自动放行,不必人工改库
    const claimed = await this.db
      .update(industryInsights)
      .set({
        buildStatus: 'running',
        buildError: null,
        windowDays,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(industryInsights.id, insight.id),
          sql`(industry_insights.build_status <> 'running' or industry_insights.updated_at < now() - interval '10 minutes')`,
        ),
      )
      .returning({ id: industryInsights.id });
    if (claimed.length === 0) {
      throw new HttpException('该行业洞察正在聚合中,请稍候', HttpStatus.CONFLICT);
    }

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
