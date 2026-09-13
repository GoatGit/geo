import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  brands,
  collectionPlans,
  recognitionEntries,
  recognitionVersions,
  subscriptions,
} from '@geo/db';
import { PLAN_LIMITS, WEB_ENGINES, type PlanTier } from '@geo/shared';
import { parseBrandDescription } from './brand-intelligence';
import { DB } from '../common/infra.module';

@Injectable()
export class BrandsService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  /**
   * 品牌初始化(docs/01 §3.1):解析 → 档案草稿 → 识别口径预填(A1 对策:
   * 自有产品线别名默认确认)→ 订阅 → 全引擎采集计划(引导用户补问题)。
   */
  async create(input: { accountId: number; description: string; plan?: PlanTier }) {
    const draft = parseBrandDescription(input.description);
    const plan: PlanTier = input.plan ?? 'free';

    const brand = (
      await this.db
        .insert(brands)
        .values({
          accountId: input.accountId,
          name: draft.name,
          industry: draft.industry,
          website: draft.website,
          intro: draft.intro,
        })
        .returning()
    )[0]!;

    // 识别口径:本品 + AI 建议别名(默认勾选),竞品进入草稿(待确认)
    const selfEntry = (
      await this.db
        .insert(recognitionEntries)
        .values({
          brandId: brand.id,
          kind: 'self',
          name: draft.name,
          aliases: draft.suggestedAliases,
          note: 'AI 建议别名(含自有产品线,默认勾选)',
          source: 'ai',
          confirmed: true,
        })
        .returning()
    )[0]!;
    for (const c of draft.suggestedCompetitors) {
      await this.db.insert(recognitionEntries).values({
        brandId: brand.id,
        kind: 'competitor',
        name: c.name,
        aliases: [],
        note: c.note,
        source: 'ai',
        confirmed: false,
      });
    }
    await this.snapshotRecognition(brand.id);

    const limits = PLAN_LIMITS[plan];
    await this.db.insert(subscriptions).values({
      accountId: input.accountId,
      brandId: brand.id,
      plan,
      questionQuota: { ranking: limits.rankingQuota, reputation: limits.reputationQuota },
      engineQuota: { web: limits.webEngines, app: limits.appEngines },
      freq: 1,
    });

    // 采集计划:网页端全引擎(免费版取前 3 个,与 M0 交付对齐)
    const engines = WEB_ENGINES.slice(0, plan === 'free' ? limits.webEngines : WEB_ENGINES.length);
    await this.db.insert(collectionPlans).values({
      brandId: brand.id,
      engines: engines as unknown as string[],
      surfaces: ['web'],
      freq: 1,
      nextRunAt: null, // 首轮由"问题配置完成"触发,避免空跑(教训 #3)
    });

    return {
      brand,
      profileDraft: draft,
      recognition: { self: selfEntry, competitorsDraft: draft.suggestedCompetitors },
      plan,
      engines,
    };
  }

  async list(accountId: number) {
    return this.db.select().from(brands).where(eq(brands.accountId, accountId));
  }

  async getOwned(accountId: number, brandId: number) {
    const brand = (
      await this.db
        .select()
        .from(brands)
        .where(and(eq(brands.id, brandId), eq(brands.accountId, accountId)))
        .limit(1)
    )[0];
    if (!brand) throw new HttpException('品牌不存在', HttpStatus.NOT_FOUND);
    return brand;
  }

  /** 口径版本化(docs/research 03-B):每次口径变更落一版快照。 */
  async snapshotRecognition(brandId: number) {
    const entries = await this.db
      .select()
      .from(recognitionEntries)
      .where(eq(recognitionEntries.brandId, brandId));
    await this.db.insert(recognitionVersions).values({
      brandId,
      profile: {
        self: entries.find((e) => e.kind === 'self') ?? null,
        competitors: entries.filter((e) => e.kind === 'competitor'),
        takenAt: new Date().toISOString(),
      },
    });
  }

  async assertBrandQuota(accountId: number) {
    const count = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(brands)
      .where(eq(brands.accountId, accountId));
    return (count[0]?.n ?? 0) as number;
  }
}
