import { HttpException, HttpStatus, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import {
  industryInsights, insightIndustries, brands, monitoringQuestions, loadPlatformSettings,
  accounts, orders, insightBrands, insightQuestions, recognitionEntries, subscriptions, collectionPlans,
  accountIndustrySubs,
} from '@geo/db';
import { WEB_ENGINES } from '@geo/shared';
import { chatCompletion, InsightAgent } from '@geo/insight-agent';
import { normalizeWebsiteInput, probeWebsite } from './website-discovery';
import { INSIGHTS_QUEUE, type InsightBuildStatus } from '@geo/shared';
import type { InsightBlock, InsightCover } from '@geo/shared';
import { INSIGHT_BLOCK_TYPES, INSIGHT_QUESTION_LAYERS, PLAN_LIMITS, type PlanTier } from '@geo/shared';

/** 档位权重(与 billing.PLAN_RANK 同口径,避免循环依赖本地复制)。 */
const PLAN_RANK: Record<PlanTier, number> = { free: 0, starter: 1, standard: 2, pro: 3, custom: 4 };
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
  /** 披露/偏向说明(报告尾部信任层) */
  disclosure?: string | null;
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
            website: normalizeWebsiteInput(String(b.website ?? '')),
            positioning: b.positioning ? String(b.positioning).trim().slice(0, 60) : null,
          })
          .returning()
      )[0]!;
      created.push({ id: row.id, name: row.name });
    }
    return { created };
  }

  /**
   * 官网自动发现(品牌资产精品化):LLM 提议候选 → 探测验证(可达 + 域名族) → 验证通过才落库。
   * 宁缺毋滥:候选为空/格式无效/不可达都不写,前端可重试。
   */
  async discoverIndustryBrandWebsite(industryId: number, brandId: number) {
    const industry = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!industry) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const brand = (
      await this.db
        .select()
        .from(insightBrands)
        .where(and(eq(insightBrands.id, brandId), eq(insightBrands.industryId, industryId)))
        .limit(1)
    )[0];
    if (!brand) throw new HttpException('行业品牌不存在', HttpStatus.NOT_FOUND);
    if (brand.website) return { website: brand.website, discovered: false, note: '已有官网' };

    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
      throw new HttpException('需先在「全局配置 → Insight Agent」启用 LLM', HttpStatus.BAD_REQUEST);
    }
    const agent = new InsightAgent({ settings: cfg });
    const candidate = await agent.suggestBrandWebsite({
      name: brand.name,
      industry: industry?.name ?? undefined,
      positioning: brand.positioning ?? undefined,
    });
    if (!candidate?.url) {
      return { website: null, discovered: false, error: 'AI 未能给出候选官网(可能是不知名品牌)' };
    }
    const normalized = normalizeWebsiteInput(candidate.url);
    if (!normalized) {
      return { website: null, discovered: false, error: `候选官网格式无效: ${candidate.url.slice(0, 60)}` };
    }
    const probe = await probeWebsite(normalized);
    if (!probe.ok) {
      return { website: null, discovered: false, error: `候选官网不可达: ${normalized}(${probe.error ?? probe.status ?? '未知'})` };
    }
    await this.db.update(insightBrands).set({ website: normalized }).where(eq(insightBrands.id, brandId));
    return { website: normalized, discovered: true, confidence: candidate.confidence };
  }

  // ===== 向导步骤③:行业问题(单份,行业级) =====

  async listIndustryQuestions(industryId: number) {
    return this.db
      .select()
      .from(insightQuestions)
      .where(eq(insightQuestions.industryId, industryId))
      .orderBy(insightQuestions.id);
  }

  async addIndustryQuestion(
    industryId: number,
    text: string,
    type: 'ranking' | 'reputation',
    layer?: string | null,
  ) {
    const clean = text.trim();
    if (clean.length < 8 || clean.length > 60) throw new HttpException('问题长度需在 8-60 字', HttpStatus.BAD_REQUEST);
    if (layer != null && !(INSIGHT_QUESTION_LAYERS as readonly string[]).includes(layer)) {
      throw new HttpException(`未知的问题分层: ${layer}`, HttpStatus.BAD_REQUEST);
    }
    const row = (
      await this.db
        .insert(insightQuestions)
        .values({ industryId, textRaw: clean, type: type === 'reputation' ? 'reputation' : 'ranking', layer: layer ?? null })
        .returning()
    )[0]!;
    return { id: row.id, text: row.textRaw, layer: row.layer };
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
          // 分层随问题同步到 group_name:聚合层据此还原品牌 × 问题层命中率
          groupName: q.layer ?? undefined,
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

    // 该行业从无采集记录 → 自动起首轮采集(否则首份报告必然全空,用户还得再猜一步)
    let autoCollected = false;
    try {
      const everRan = (await this.db.execute(sql`
        select 1 from query_runs qr
        join brands b on b.id = qr.brand_id
        join accounts a on a.id = b.account_id
        where b.industry = ${industry.name} and a.phone = '10000000000'
        limit 1
      `)) as unknown as { rows: unknown[] };
      if ((everRan.rows ?? []).length === 0) {
        await this.collectNow(industryId);
        autoCollected = true;
      }
    } catch (err) {
      // 影子品牌未建成等场景:不阻断生成,等待稿会给出手动采集指引
      console.error(`[insights] 自动起采集失败(忽略)industry=${industryId}:`, (err as Error).message.slice(0, 120));
    }

    await this.insightsQueue.add('build', { insightId: insight.id, windowDays, autoCollected }, { attempts: 1, removeOnComplete: 100 });
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
          disclosure: input.disclosure ?? null,
          publishedAt: input.status === 'published' ? new Date() : null,
        })
        .returning()
    )[0]!;
    return this.adminGet(row.id);
  }

  async update(id: number, patch: Partial<UpsertInsightInput>) {
    if (patch.blocks !== undefined) validateBlocks(patch.blocks);
    const next: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ['industryId', 'issue', 'title', 'summary', 'cover', 'blocks', 'status', 'featured', 'disclosure'] as const) {
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

  // ===== 用户侧(行业洞察一等公民:hub / 自建自管 / 订阅 / 生成 / 分享)=====

  /** 账号生效档位(账号级订阅取最高,billing 同口径;无订阅=free)。 */
  private async planOf(accountId: number): Promise<PlanTier> {
    const rows = await this.db
      .select({ plan: subscriptions.plan, status: subscriptions.status, periodEnd: subscriptions.periodEnd })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    let best: PlanTier = 'free';
    let bestRank = -1;
    for (const r of rows) {
      if (r.status !== 'active') continue;
      if (r.periodEnd && r.periodEnd.getTime() < Date.now()) continue;
      const rank = PLAN_RANK[(r.plan as PlanTier) ?? 'free'] ?? 0;
      if (rank > bestRank) {
        bestRank = rank;
        best = (r.plan as PlanTier) ?? 'free';
      }
    }
    return best;
  }

  /** 我的行业 id 集 = 自建(account_id=本人) ∪ 订阅(0014)。 */
  private async myIndustryIds(accountId: number): Promise<Set<number>> {
    const created = await this.db
      .select({ id: insightIndustries.id })
      .from(insightIndustries)
      .where(eq(insightIndustries.accountId, accountId));
    const subs = await this.db
      .select({ id: accountIndustrySubs.industryId })
      .from(accountIndustrySubs)
      .where(eq(accountIndustrySubs.accountId, accountId));
    return new Set([...created.map((c) => c.id), ...subs.map((x) => x.id)]);
  }

  /** 订阅制守卫:自建/已订阅/管理员(豁免)可执行;其余 403。 */
  private async assertIndustryAccess(
    industryId: number,
    accountId: number,
    isAdmin: boolean,
    action = '操作',
  ) {
    const ind = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!ind) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    if (isAdmin) return ind; // 管理员豁免:平台运营不受归属限制(截图报错即为该 bug)
    if (ind.accountId === accountId) return ind;
    const sub = (
      await this.db
        .select({ accountId: accountIndustrySubs.accountId })
        .from(accountIndustrySubs)
        .where(
          and(eq(accountIndustrySubs.accountId, accountId), eq(accountIndustrySubs.industryId, industryId)),
        )
        .limit(1)
    );
    if (sub.length === 0) {
      throw new HttpException(`尚未开通该行业;在行业洞察页订阅后即可${action}`, HttpStatus.FORBIDDEN);
    }
    return ind;
  }

  /**
   * 订阅行业(0014 跨行业洞察):公共/他人行业可订阅,生成走自己配额;
   * 配额 = 自建 ∪ 订阅 总数 ≤ 套餐 insightIndustries;管理员豁免配额。
   */
  async subscribeIndustry(accountId: number, industryId: number, isAdmin: boolean) {
    const ind = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!ind) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    const mine = await this.myIndustryIds(accountId);
    if (mine.has(industryId)) return { industryId, alreadyOpen: true };
    if (!isAdmin) {
      const quota = PLAN_LIMITS[await this.planOf(accountId)].insightIndustries;
      if (mine.size >= quota) {
        throw new HttpException(
          `当前套餐最多开通 ${quota} 个行业(${mine.size} 个已用),升级套餐或退订后再试`,
          HttpStatus.FORBIDDEN,
        );
      }
    }
    await this.db
      .insert(accountIndustrySubs)
      .values({ accountId, industryId })
      .onConflictDoNothing();
    return { industryId, alreadyOpen: false };
  }

  /** 退订(自建行业走删除,订阅行业走退订)。 */
  async unsubscribeIndustry(accountId: number, industryId: number) {
    const ind = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!ind) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    if (ind.accountId === accountId) {
      throw new HttpException('自建行业请直接删除(删除即退订)', HttpStatus.BAD_REQUEST);
    }
    await this.db
      .delete(accountIndustrySubs)
      .where(
        and(eq(accountIndustrySubs.accountId, accountId), eq(accountIndustrySubs.industryId, industryId)),
      );
    return { unsubscribed: true };
  }



  /** 归属守卫:仅用户自建(account_id=本人)的行业可配置/删除;平台公共行业只能生成/查看。 */
  private async assertIndustryOwner(industryId: number, accountId: number) {
    const ind = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.id, industryId)).limit(1)
    )[0];
    if (!ind) throw new HttpException('行业不存在', HttpStatus.NOT_FOUND);
    if (ind.accountId !== accountId) {
      throw new HttpException('平台公共行业由平台配置;仅自建行业可修改', HttpStatus.FORBIDDEN);
    }
    return ind;
  }

  /** 用户自建行业:不再要求与本人品牌行业一致(自服务);同名平台行业视为已开通(公共)。 */
  async createIndustryForAccount(accountId: number, name: string) {
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 20) {
      throw new HttpException('行业名需在 2-20 字', HttpStatus.BAD_REQUEST);
    }
    const existing = (
      await this.db.select().from(insightIndustries).where(eq(insightIndustries.name, clean)).limit(1)
    )[0];
    if (existing) {
      return { industryId: existing.id, name: existing.name, alreadyOpen: true };
    }
    const created = (
      await this.db
        .insert(insightIndustries)
        .values({ name: clean, active: true, accountId })
        .returning({ id: insightIndustries.id, name: insightIndustries.name })
    )[0]!;
    return { industryId: created.id, name: created.name, alreadyOpen: false };
  }

  /** 用户删除自建行业:有报告时先删报告;影子品牌有采集数据时保留(不可见,无副作用)。 */
  async removeIndustryForAccount(accountId: number, industryId: number) {
    const ind = await this.assertIndustryOwner(industryId, accountId);
    const reports = (
      await this.db
        .select({ id: industryInsights.id })
        .from(industryInsights)
        .where(eq(industryInsights.industryId, industryId))
        .limit(1)
    );
    // 自服务闭环:本人行业的洞察报告一并删除(blocks 在行内,删行即可)
    await this.db.delete(industryInsights).where(eq(industryInsights.industryId, industryId));

    // 影子品牌链清理:无采集数据才整链删除;有数据保留孤儿(不可见,避免 FK 级联误删证据)
    const sentinelId = await this.sentinelAccountId();
    const shadow = (
      await this.db
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.accountId, sentinelId), eq(brands.industry, ind.name)))
        .limit(1)
    )[0];
    if (shadow) {
      const hasRuns = (
        await this.db.select({ id: sql`1` }).from(sql`query_runs`).where(sql`brand_id = ${shadow.id} limit 1`)
      ).length;
      if (Number(hasRuns) === 0) {
        await this.db.delete(monitoringQuestions).where(eq(monitoringQuestions.brandId, shadow.id));
        await this.db.delete(recognitionEntries).where(eq(recognitionEntries.brandId, shadow.id));
        await this.db.delete(collectionPlans).where(eq(collectionPlans.brandId, shadow.id));
        await this.db.delete(subscriptions).where(eq(subscriptions.brandId, shadow.id));
        await this.db.delete(brands).where(eq(brands.id, shadow.id));
      }
    }
    await this.db.delete(insightIndustries).where(eq(insightIndustries.id, industryId));
    return { deleted: true };
  }

  /** 用户侧归属校验(配置类操作共用):仅自建行业;读型操作用 assertOwnedThen 包装。 */
  private async ownedIndustryId(accountId: number, industryId: number): Promise<string> {
    const ind = await this.assertIndustryOwner(industryId, accountId);
    return ind.name;
  }

  /** 读型操作守卫:校验归属后执行委托(避免每个读端点写一遍 try/catch)。 */
  async assertOwnedThen<T>(industryId: number, accountId: number, fn: () => Promise<T>): Promise<T> {
    await this.assertIndustryOwner(industryId, accountId);
    return fn();
  }



  /** 用户品牌所属的行业名集合(与洞察行业表按名对齐)。 */
  async industriesOfAccount(accountId: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ industry: brands.industry })
      .from(brands)
      .where(eq(brands.accountId, accountId));
    return rows.map((r) => r.industry).filter((x): x is string => Boolean(x));
  }

  /**
   * 用户 hub:我的行业洞察(本人行业全部状态的最新一期,含可生成/分享态)+ 官方已发布流。
   */
  async hub(accountId: number, isAdmin = false) {
    const myIds = await this.myIndustryIds(accountId);
    const all = await this.db.select().from(insightIndustries).where(eq(insightIndustries.active, true));
    // 我的行业 = 自建 ∪ 订阅(0014);订阅制不再要求与品牌行业一致
    const mine = await Promise.all(
      all
        .filter((ind) => myIds.has(ind.id))
        .map(async (ind) => {
          // 平台是否已配置监测品牌(未配置时产品页置灰生成按钮,避免必然失败的提交)
          const brandCount = await this.db
            .select({ id: insightBrands.id })
            .from(insightBrands)
            .where(eq(insightBrands.industryId, ind.id))
            .limit(1);
          const latest = (
            await this.db
              .select()
              .from(industryInsights)
              .where(eq(industryInsights.industryId, ind.id))
              .orderBy(desc(industryInsights.updatedAt))
              .limit(1)
          )[0];
          return {
            industryId: ind.id,
            industry: ind.name,
            owned: ind.accountId === accountId,
            /** 订阅的公共/他人行业(0014):可生成可退订,不可配置 */
            subscribed: ind.accountId !== accountId,
            configured: brandCount.length > 0,
            insight: latest
              ? {
                  id: latest.id,
                  issue: latest.issue,
                  title: latest.title,
                  summary: latest.summary,
                  status: latest.status,
                  buildStatus: latest.buildStatus,
                  builtAt: latest.builtAt,
                  windowDays: latest.windowDays,
                  shareStatus: latest.shareStatus,
                  shareNote: latest.shareNote,
                }
              : null,
          };
        }),
    );
    const official = await this.publishedList();
    // 行业库(0014 跨行业订阅):全部可订阅行业 - 我的;configured 如实返回
    // (此前硬编码 true——用户订阅「待配置」行业后才发现生成按钮要等,实测误导)
    const library = await Promise.all(
      all
        .filter((ind) => !myIds.has(ind.id))
        .map(async (ind) => ({
          industryId: ind.id,
          industry: ind.name,
          configured:
            (
              await this.db
                .select({ id: insightBrands.id })
                .from(insightBrands)
                .where(eq(insightBrands.industryId, ind.id))
                .limit(1)
            ).length > 0,
        })),
    );
    const quota = isAdmin ? Number.MAX_SAFE_INTEGER : PLAN_LIMITS[await this.planOf(accountId)].insightIndustries;
    return { mine, official, library, quota, used: mine.length, hasBrands: (await this.industriesOfAccount(accountId)).length > 0 };
  }

  /** 开通行业(0014 订阅制):行业库已有 → 订阅;没有 → 自建(自动订阅)。不再要求与品牌行业一致。 */
  async applyIndustry(accountId: number, name: string, isAdmin = false) {
    const existing = (await this.db.select().from(insightIndustries).where(eq(insightIndustries.name, name)).limit(1))[0];
    if (existing) return this.subscribeIndustry(accountId, existing.id, isAdmin);
    // 自建:配额同样校验
    const mine = await this.myIndustryIds(accountId);
    if (!isAdmin) {
      const quota = PLAN_LIMITS[await this.planOf(accountId)].insightIndustries;
      if (mine.size >= quota) {
        throw new HttpException(`当前套餐最多开通 ${quota} 个行业(${mine.size} 个已用),升级套餐后再试`, HttpStatus.FORBIDDEN);
      }
    }
    const created = (
      await this.db.insert(insightIndustries).values({ name: name.trim(), active: true, accountId }).returning({ id: insightIndustries.id })
    )[0]!;
    await this.db.insert(accountIndustrySubs).values({ accountId, industryId: created.id }).onConflictDoNothing();
    return { industryId: created.id, alreadyOpen: false };
  }

  /** 用户触发生成(0014 订阅制):自建/已订阅/管理员可触发;每行业 12h 频控。 */
  async runForAccount(accountId: number, industryId: number, windowDays: number | null, isAdmin = false) {
    const industry = await this.assertIndustryAccess(industryId, accountId, isAdmin, '生成');
    const latest = (
      await this.db
        .select({ builtAt: industryInsights.builtAt, cover: industryInsights.cover })
        .from(industryInsights)
        .where(eq(industryInsights.industryId, industryId))
        .orderBy(desc(industryInsights.builtAt))
        .limit(1)
    )[0];
    if (latest?.builtAt && Date.now() - latest.builtAt.getTime() < 12 * 3600 * 1000) {
      // 零数据等待稿豁免频控:重建不进 LLM(成本≈0),且「采集完成后重生成」的指引
      // 恰好在几分钟内 —— 12h 锁会把刚起的首轮采集卡死到明天(实测零食行业)
      const zeroData = ((latest.cover as { answers?: number } | null) ?? {}).answers === 0;
      if (!zeroData) {
        const waitH = Math.ceil((12 * 3600 * 1000 - (Date.now() - latest.builtAt.getTime())) / 3600_000);
        throw new HttpException(`该行业 ${waitH} 小时内已生成过,稍后再试`, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    return this.runIndustry(industryId, windowDays);
  }

  // ===== 自服务配置包装(归属校验后委托既有实现;平台公共行业不可配置)=====

  async suggestBrandsForAccount(accountId: number, industryId: number) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.suggestIndustryBrands(industryId);
  }
  async createBrandsForAccount(
    accountId: number,
    industryId: number,
    list: Array<{ name: string; website?: string; aliases?: string[]; positioning?: string }>,
  ) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.createIndustryBrands(industryId, list);
  }
  async removeBrandForAccount(accountId: number, industryId: number, brandId: number) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.removeIndustryBrand(industryId, brandId);
  }
  async discoverWebsiteForAccount(accountId: number, industryId: number, brandId: number) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.discoverIndustryBrandWebsite(industryId, brandId);
  }
  async addQuestionForAccount(
    accountId: number,
    industryId: number,
    text: string,
    type: 'ranking' | 'reputation',
    layer?: string | null,
  ) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.addIndustryQuestion(industryId, text, type, layer ?? null);
  }
  async removeQuestionForAccount(accountId: number, industryId: number, questionId: number) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.removeIndustryQuestionRow(industryId, questionId);
  }
  async suggestQuestionsForAccount(accountId: number, industryId: number, apply: boolean) {
    await this.assertIndustryOwner(industryId, accountId);
    return this.suggestIndustryQuestions(industryId, apply);
  }
  async collectNowForAccount(accountId: number, industryId: number) {
    await this.assertIndustryOwner(industryId, accountId);
    const shadowId = await this.syncShadowBrand(industryId);
    await this.db.update(collectionPlans).set({ nextRunAt: new Date() }).where(eq(collectionPlans.brandId, shadowId));
    return { triggered: true };
  }

  /** 用户提交分享:本人行业报告 → 待审核。 */
  async submitShare(accountId: number, insightId: number, note?: string) {
    const row = (await this.db.select().from(industryInsights).where(eq(industryInsights.id, insightId)).limit(1))[0];
    if (!row) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    await this.assertIndustryAccess(row.industryId, accountId, false, '分享');
    if (row.buildStatus !== 'idle' || !row.builtAt) {
      throw new HttpException('报告尚未生成完成', HttpStatus.CONFLICT);
    }
    if (row.shareStatus === 'pending') throw new HttpException('已提交审核,请等待平台处理', HttpStatus.CONFLICT);
    if (row.status === 'published') throw new HttpException('该报告已在官网发布', HttpStatus.CONFLICT);
    await this.db
      .update(industryInsights)
      .set({ shareStatus: 'pending', submittedBy: accountId, shareNote: note?.slice(0, 300) ?? null, updatedAt: new Date() })
      .where(eq(industryInsights.id, insightId));
    return { submitted: true };
  }

  /** 管理端:待审核分享列表。 */
  async pendingShares() {
    const rows = await this.db
      .select()
      .from(industryInsights)
      .where(eq(industryInsights.shareStatus, 'pending'))
      .orderBy(desc(industryInsights.updatedAt));
    return this.attachIndustry(rows);
  }

  /** 管理端审核:通过 → 发布(进官网首页流);驳回 → 带理由回到可再分享态。 */
  async review(id: number, approve: boolean, note?: string, reviewerAccount?: number) {
    const row = (await this.db.select().from(industryInsights).where(eq(industryInsights.id, id)).limit(1))[0];
    if (!row) throw new HttpException('报告不存在', HttpStatus.NOT_FOUND);
    if (row.shareStatus !== 'pending') throw new HttpException('该报告不在待审核状态', HttpStatus.CONFLICT);
    await this.db
      .update(industryInsights)
      .set(
        approve
          ? { shareStatus: 'approved', status: 'published', publishedAt: new Date(), updatedAt: new Date() }
          : { shareStatus: 'rejected', shareNote: note?.slice(0, 300) ?? row.shareNote, updatedAt: new Date() },
      )
      .where(eq(industryInsights.id, id));
    void reviewerAccount;
    return this.adminGet(id);
  }

  /** 详情访问控制:已发布公开;否则须是本人行业的报告(付费用户的产品能力)。 */
  async detailFor(accountId: number | null, id: number): Promise<{ row: InsightRow; mine: boolean } | null> {
    const row = (await this.db.select().from(industryInsights).where(eq(industryInsights.id, id)).limit(1))[0];
    if (!row) return null;
    if (row.status === 'published') return { row, mine: false };
    if (!accountId) return null;
    // 0014 订阅制:自建/已订阅/管理员的草稿可见(旧"品牌行业名匹配"漏掉自建与订阅行业,
    // 导致「查看报告」对本人行业 404,实测护肤品自建行业报告打不开)
    const mine = await this.myIndustryIds(accountId);
    if (mine.has(row.industryId)) return { row, mine: true };
    return null;
  }

  // ===== 1.5 数字下钻:报告数字 → 事实明细(rubric docs/10) =====

  /** 信源类型桶(与组稿器 insight-builder 同一映射,API 侧负责桶→原始类目回查)。 */
  private static readonly SOURCE_BUCKETS: Array<{ bucket: string; match: RegExp }> = [
    { bucket: 'UGC/社区', match: /ugc|社区|社交|问答/ },
    { bucket: '榜单/评测', match: /榜单|评测/ },
    { bucket: '品牌官网', match: /官网/ },
    { bucket: '新闻/垂媒', match: /门户|资讯|垂媒|媒体/ },
    { bucket: '百科', match: /百科/ },
  ];
  private bucketOf(cat: string): string {
    const c = cat.toLowerCase();
    return InsightsService.SOURCE_BUCKETS.find((b) => b.match.test(c))?.bucket ?? '其他';
  }

  /**
   * 报告事实明细分页(mention 命中记录 / citation 引用记录),窗口与报告一致
   * (builtAt 往前 windowDays;全量报告不加窗口)。访问控制同 detailFor。
   */
  async factsFor(
    accountId: number | null,
    id: number,
    q: {
      kind: 'mentions' | 'citations';
      subject?: string;
      layer?: string;
      engine?: string;
      domain?: string;
      bucket?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<
    | null
    | {
        kind: 'mentions' | 'citations';
        total: number;
        page: number;
        pageSize: number;
        rows: Array<Record<string, unknown>>;
      }
  > {
    const found = await this.detailFor(accountId, id);
    if (!found) return null;
    const { row } = found;
    const industry =
      (
        await this.db
          .select({ name: insightIndustries.name })
          .from(insightIndustries)
          .where(eq(insightIndustries.id, row.industryId))
          .limit(1)
      )[0]?.name;
    if (!industry) return null;
    const shadowRows = (await this.db.execute(sql`
      select b.id::text as id from brands b
      join accounts a on a.id = b.account_id
      where b.industry = ${industry} and a.phone = '10000000000'
      limit 1
    `)) as unknown as { rows: Array<{ id: string }> };
    const shadowId = Number(shadowRows.rows[0]?.id ?? 0);
    if (!shadowId) return { kind: q.kind, total: 0, page: q.page, pageSize: q.pageSize, rows: [] };

    // 报告数据窗口:builtAt(生成时刻)往前 windowDays 天;全量报告不加窗口
    const since =
      row.builtAt && row.windowDays
        ? new Date(row.builtAt.getTime() - row.windowDays * 86_400_000)
        : null;

    const limit = q.pageSize;
    const offset = (q.page - 1) * q.pageSize;

    if (q.kind === 'mentions') {
      const conds = [sql`mf.brand_id = ${shadowId}`, sql`mf.mentioned = true`];
      if (q.subject) conds.push(sql`mf.subject_name = ${q.subject}`);
      if (q.layer) conds.push(sql`q.group_name = ${q.layer}`);
      if (q.engine) conds.push(sql`mf.engine = ${q.engine}`);
      if (since) conds.push(sql`mf.ran_at >= ${since.toISOString()}`);
      const where = sql.join(conds, sql` and `);
      const counted = (await this.db.execute(sql`
        select count(*)::int as total
        from mention_facts mf join monitoring_questions q on q.id = mf.question_id
        where ${where}
      `)) as unknown as { rows: Array<{ total: number }> };
      const data = (await this.db.execute(sql`
        select mf.ran_at, mf.engine, mf.subject_name, mf.rank, mf.confidence,
               mf.evidence->>'snippet' as snippet,
               q.text_raw as question, q.group_name as layer
        from mention_facts mf join monitoring_questions q on q.id = mf.question_id
        where ${where}
        order by mf.ran_at desc, mf.id desc
        limit ${limit} offset ${offset}
      `)) as unknown as { rows: Array<Record<string, unknown>> };
      return { kind: 'mentions', total: counted.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize, rows: data.rows };
    }

    // citations
    const conds = [sql`cf.brand_id = ${shadowId}`];
    if (q.domain) conds.push(sql`cf.domain = ${q.domain}`);
    if (q.engine) conds.push(sql`cf.engine = ${q.engine}`);
    if (q.bucket) {
      // 桶 → 原始 platform_category 集合(与组稿器同一映射)
      const cats = (await this.db.execute(sql`
        select distinct platform_category from citation_facts where brand_id = ${shadowId}
      `)) as unknown as { rows: Array<{ platform_category: string }> };
      const members = cats.rows.map((r) => r.platform_category).filter((c) => this.bucketOf(c) === q.bucket);
      if (members.length === 0) return { kind: 'citations', total: 0, page: q.page, pageSize: q.pageSize, rows: [] };
      conds.push(sql`cf.platform_category in (${sql.join(members.map((m) => sql`${m}`), sql`, `)})`);
    }
    if (since) conds.push(sql`cf.extracted_at >= ${since.toISOString()}`);
    const where = sql.join(conds, sql` and `);
    const counted = (await this.db.execute(sql`
      select count(*)::int as total from citation_facts cf where ${where}
    `)) as unknown as { rows: Array<{ total: number }> };
    const data = (await this.db.execute(sql`
      select cf.extracted_at, cf.engine, cf.domain, cf.platform_category, cf.title,
             cf.raw_url, cf.is_owned, q.text_raw as question
      from citation_facts cf left join monitoring_questions q on q.id = cf.question_id
      where ${where}
      order by cf.extracted_at desc, cf.id desc
      limit ${limit} offset ${offset}
    `)) as unknown as { rows: Array<Record<string, unknown>> };
    return { kind: 'citations', total: counted.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize, rows: data.rows };
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
      disclosure: r.disclosure,
      buildStatus: r.buildStatus as InsightBuildStatus,
      buildError: r.buildError,
      builtAt: r.builtAt,
      windowDays: r.windowDays,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    }));
  }
}
