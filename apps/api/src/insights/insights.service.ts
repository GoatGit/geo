import { HttpException, HttpStatus, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import {
  industryInsights, insightIndustries, brands, monitoringQuestions, loadPlatformSettings,
  accounts, orders, insightBrands, insightQuestions, recognitionEntries, subscriptions, collectionPlans,
} from '@geo/db';
import { WEB_ENGINES } from '@geo/shared';
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

  /** 行业哨兵账号:向导创建的行业品牌挂在它名下(不占租户套餐配额;
   *  custom 档不限品牌数,plan 由一条 0 元已支付订单授予,永久有效)。 */
  async sentinelAccountId(): Promise<number> {
    const phone = '10000000000';
    let acct = (await this.db.select().from(accounts).where(eq(accounts.phone, phone)).limit(1))[0];
    if (!acct) {
      acct = (await this.db.insert(accounts).values({ phone, role: 'user', status: 'active' }).returning())[0]!;
      await this.db.insert(orders).values({
        outTradeNo: `sentinel-${acct.id}`,
        accountId: acct.id,
        product: 'plan',
        plan: 'custom',
        period: 'yearly',
        channel: 'mock',
        amountCents: 0,
        status: 'paid',
        paidAt: new Date(),
        expireAt: new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
        meta: { note: '行业洞察哨兵账号:向导创建的行业品牌不占租户配额' },
      });
    }
    return acct.id;
  }

  // ===== 向导步骤②:行业品牌(独立模型,docs/01 IA ⑤;不是租户监测品牌) =====

  async listIndustryBrands(industryId: number) {
    return this.db
      .select()
      .from(insightBrands)
      .where(eq(insightBrands.industryId, industryId))
      .orderBy(insightBrands.id);
  }

  async removeIndustryBrand(industryId: number, brandId: number) {
    await this.db
      .delete(insightBrands)
      .where(and(eq(insightBrands.id, brandId), eq(insightBrands.industryId, industryId)));
    return { deleted: true };
  }

  /** AI 推荐行业品牌:LLM 产出候选(名称/官网/定位),前端勾选后 create。 */
  async suggestIndustryBrands(industryId: number) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
      throw new HttpException('需先在「全局配置 → Insight Agent」启用 LLM', HttpStatus.BAD_REQUEST);
    }
    const existing = await this.db.select({ name: insightBrands.name }).from(insightBrands).where(eq(insightBrands.industryId, industryId));

    const system =
      '你是行业研究员。为"行业 AI 可见度洞察报告"挑选报告主体品牌。只输出一个 JSON 对象。' +
      'schema: {"brands":[{"name":"品牌名(2-12字)","website":"官网域名","aliases":["常见叫法/简称"],"positioning":"一句话定位(≤30字)"}]}。' +
      '要求:5-8 个该行业真实存在的头部+成长期品牌(消费者在 AI 里会问到的);覆盖不同定位梯队;避开已收录品牌。';
    const raw = await chatCompletion(
      { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
      { system, user: JSON.stringify({ 行业: industry.name, 已收录: existing.map((b) => b.name) }), maxTokens: 1400 },
    );
    const m = raw.text.match(/\{[\s\S]*\}/);
    if (!m) throw new HttpException('AI 返回格式异常,请重试', HttpStatus.BAD_GATEWAY);
    const parsed = JSON.parse(m[0]) as {
      brands?: Array<{ name?: string; website?: string; aliases?: string[]; positioning?: string }>;
    };
    const suggestions = (parsed.brands ?? [])
      .map((b) => ({
        name: String(b.name ?? '').trim(),
        website: String(b.website ?? '').trim(),
        aliases: (b.aliases ?? []).map((a) => String(a).trim()).filter(Boolean).slice(0, 6),
        positioning: String(b.positioning ?? '').trim().slice(0, 60),
      }))
      .filter((b) => b.name.length >= 2 && !existing.some((e) => e.name === b.name))
      .slice(0, 8);
    if (suggestions.length === 0) throw new HttpException('AI 未给出有效品牌建议,请重试', HttpStatus.BAD_GATEWAY);
    return { industry: industry.name, suggestions };
  }

  /** 收录行业品牌(勾选的 AI 建议 + 手动):写 insight_brands,不占任何租户配额。 */
  async createIndustryBrands(
    industryId: number,
    list: Array<{ name: string; website?: string; aliases?: string[]; positioning?: string }>,
  ) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const created: Array<{ id: number; name: string }> = [];
    for (const b of list.slice(0, 8)) {
      const name = String(b.name ?? '').trim();
      if (name.length < 2) continue;
      const exists = (await this.db.select({ id: insightBrands.id }).from(insightBrands).where(and(eq(insightBrands.industryId, industryId), eq(insightBrands.name, name))).limit(1))[0];
      if (exists) {
        created.push({ id: exists.id, name });
        continue;
      }
      const row = (
        await this.db
          .insert(insightBrands)
          .values({
            industryId,
            name,
            aliases: (b.aliases ?? []).map((a) => String(a).trim()).filter(Boolean).slice(0, 6),
            website: b.website ? String(b.website).trim() : null,
            positioning: b.positioning ? String(b.positioning).trim().slice(0, 60) : null,
          })
          .returning()
      )[0]!;
      created.push({ id: row.id, name: row.name });
    }
    return { created };
  }

  // ===== 向导步骤③:行业问题(单份,行业级) =====

  async listIndustryQuestions(industryId: number) {
    return this.db
      .select()
      .from(insightQuestions)
      .where(eq(insightQuestions.industryId, industryId))
      .orderBy(insightQuestions.id);
  }

  async addIndustryQuestion(industryId: number, text: string, type: 'ranking' | 'reputation') {
    const clean = text.trim();
    if (clean.length < 8 || clean.length > 60) throw new HttpException('问题长度需在 8-60 字', HttpStatus.BAD_REQUEST);
    const row = (
      await this.db.insert(insightQuestions).values({ industryId, textRaw: clean, type: type === 'reputation' ? 'reputation' : 'ranking' }).returning()
    )[0]!;
    return { id: row.id, text: row.textRaw };
  }

  async removeIndustryQuestionRow(industryId: number, questionId: number) {
    await this.db.delete(insightQuestions).where(and(eq(insightQuestions.id, questionId), eq(insightQuestions.industryId, industryId)));
    return { deleted: true };
  }

  // ===== 影子品牌:行业采集的执行载体 =====

  /** 同步影子品牌:brands 行(哨兵账号)+ 订阅 + 采集计划;识别口径=行业品牌清单
   *  (competitor 确认态,mention 抽取即记录各行业品牌);问题=行业问题单份。
   *  幂等:每次全量对齐(删除多余的,插入缺失的)。返回影子品牌 id。 */
  async syncShadowBrand(industryId: number): Promise<number> {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const sentinelId = await this.sentinelAccountId();

    let shadow = (
      await this.db.select().from(brands).where(and(eq(brands.accountId, sentinelId), eq(brands.industry, industry.name))).limit(1)
    )[0];
    if (!shadow) {
      shadow = (
        await this.db
          .insert(brands)
          .values({
            accountId: sentinelId,
            name: `${industry.name}·行业洞察`,
            industry: industry.name,
            intro: '行业洞察哨兵品牌(系统自动管理,勿手工修改)',
            status: 'active',
          })
          .returning()
      )[0]!;
      await this.db.insert(subscriptions).values({
        accountId: sentinelId,
        brandId: shadow.id,
        plan: 'custom',
        questionQuota: { ranking: 500, reputation: 200 },
        engineQuota: { web: WEB_ENGINES.length },
        freq: 1,
        status: 'active',
        periodEnd: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
      });
      await this.db.insert(collectionPlans).values({
        brandId: shadow.id,
        engines: WEB_ENGINES as unknown as string[],
        surfaces: ['web'],
        freq: 1,
        timezone: 'Asia/Shanghai',
        active: true,
      });
    }

    // 识别口径对齐 = 行业品牌清单(competitor 确认态 → 参与识别)
    const wanted = await this.db.select().from(insightBrands).where(and(eq(insightBrands.industryId, industryId), eq(insightBrands.active, true)));
    await this.db.delete(recognitionEntries).where(eq(recognitionEntries.brandId, shadow.id));
    for (const b of wanted) {
      await this.db.insert(recognitionEntries).values({
        brandId: shadow.id,
        kind: 'competitor',
        name: b.name,
        aliases: b.aliases ?? [],
        note: b.positioning ?? '行业洞察主体',
        source: 'manual',
        confirmed: true,
      });
    }

    // 问题对齐 = 行业问题单份
    const qs = await this.db.select().from(insightQuestions).where(and(eq(insightQuestions.industryId, industryId), eq(insightQuestions.active, true)));
    const existingQs = await this.db.select().from(monitoringQuestions).where(eq(monitoringQuestions.brandId, shadow.id));
    const wantedTexts = new Set(qs.map((q) => q.textRaw));
    for (const q of existingQs) {
      if (!wantedTexts.has(q.textRaw) && q.status === 'active') {
        await this.db.update(monitoringQuestions).set({ status: 'archived' }).where(eq(monitoringQuestions.id, q.id));
      }
    }
    const existingTexts = new Set(existingQs.filter((q) => q.status === 'active').map((q) => q.textRaw));
    for (const q of qs) {
      if (!existingTexts.has(q.textRaw)) {
        await this.db.insert(monitoringQuestions).values({
          brandId: shadow.id,
          textRaw: q.textRaw,
          textExpanded: q.textRaw,
          type: q.type === 'reputation' ? 'reputation' : 'ranking',
          status: 'active',
        });
      }
    }
    return shadow.id;
  }

  /** 「立即采集」:同步影子品牌 → 触发一轮采集(调度器 1 分钟内领取)。 */
  async collectNow(industryId: number) {
    const shadowId = await this.syncShadowBrand(industryId);
    await this.db.update(collectionPlans).set({ nextRunAt: new Date() }).where(eq(collectionPlans.brandId, shadowId));
    return { shadowBrandId: shadowId, triggered: true };
  }

  /** 行业问题 AI 生成器:LLM 生成行业视角问题(格局/对比/口碑);
   *  apply=false 只返回建议,apply=true 落 insight_questions(单份)。 */
  async suggestIndustryQuestions(industryId: number, apply: boolean) {
    const industry = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1))[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
      throw new HttpException('需先在「全局配置 → Insight Agent」启用 LLM', HttpStatus.BAD_REQUEST);
    }
    const brandRows = await this.db.select({ name: insightBrands.name }).from(insightBrands).where(and(eq(insightBrands.industryId, industryId), eq(insightBrands.active, true)));
    if (brandRows.length === 0) throw new HttpException('请先收录行业品牌', HttpStatus.BAD_REQUEST);

    const system =
      '你是市场调研专家,为"行业 AI 可见度洞察报告"设计行业级监控问题。只输出一个 JSON 对象。' +
      'schema: {"questions":[{"type":"ranking|reputation","text":"问题(15-35字,自然口语,像真实用户问 AI)"}]}。' +
      '要求:8 个问题,覆盖 ①行业格局(如「XX行业品牌排行榜前十」) ②品类选购对比 ③头部品牌对比 ④口碑与投诉;ranking 与 reputation 约各半;' +
      '问题必须是"行业视角"——答案里自然出现多个品牌,才能聚合出行业声场。';
    const raw = await chatCompletion(
      { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
      { system, user: JSON.stringify({ 行业: industry.name, 已收录品牌: brandRows.map((b) => b.name) }), maxTokens: 900 },
    );
    const m = raw.text.match(/\{[\s\S]*\}/);
    if (!m) throw new HttpException('AI 返回格式异常,请重试', HttpStatus.BAD_GATEWAY);
    const parsed = JSON.parse(m[0]) as { questions?: Array<{ type?: string; text?: string }> };
    const questions = (parsed.questions ?? [])
      .map((q) => ({ type: q.type === 'reputation' ? ('reputation' as const) : ('ranking' as const), text: String(q.text ?? '').trim() }))
      .filter((q) => q.text.length >= 8 && q.text.length <= 60)
      .slice(0, 8);
    if (questions.length < 3) throw new HttpException('AI 生成的问题过少,请重试', HttpStatus.BAD_GATEWAY);

    if (apply) {
      for (const q of questions) {
        await this.db.insert(insightQuestions).values({ industryId, textRaw: q.text, type: q.type });
      }
    }
    return { industry: industry.name, questions, applied: apply };
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

  /**
   * 官网首页(公开,无需登录):所有已发布报告进首页精选流(发布即上首页),
   * 人工精选(featured)置顶,其余按发布时间。此前要求 featured=true 才展示,
   * 导致「发布」后首页始终为空。
   */
  async featured() {
    const rows = await this.db
      .select()
      .from(industryInsights)
      .where(eq(industryInsights.status, 'published'))
      .orderBy(desc(industryInsights.featured), desc(industryInsights.publishedAt))
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
