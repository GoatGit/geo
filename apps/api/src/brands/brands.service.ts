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
import { BillingService } from '../billing/billing.service';
import { DB } from '../common/infra.module';

@Injectable()
export class BrandsService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    private readonly billing: BillingService,
  ) {}

  /**
   * 品牌初始化(docs/01 §3.1):解析 → 档案草稿 → 识别口径预填(A1 对策:
   * 自有产品线别名默认确认)→ 订阅 → 全引擎采集计划(引导用户补问题)。
   * 全程单事务:任一步失败整体回滚,不留"无订阅/无采集计划"的品牌残骸。
   * 档位强制跟随账号会员(不信任租户传入 plan —— 防 plan 提权,docs/01 §3.10)。
   */
  async create(input: { accountId: number; description: string }) {
    const draft = parseBrandDescription(input.description);
    const membership = await this.billing.accountMembership(input.accountId);
    const plan: PlanTier = membership.plan;

    // 套餐门控:multiBrand 上限(docs/01 §3.10;custom/无限档跳过)
    const maxBrands = PLAN_LIMITS[plan].multiBrand;
    if (Number.isFinite(maxBrands)) {
      const owned = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(brands)
        .where(eq(brands.accountId, input.accountId));
      if ((owned[0]?.n ?? 0) >= maxBrands) {
        throw new HttpException(
          `当前套餐最多创建 ${maxBrands} 个品牌,升级套餐可解锁更多`,
          HttpStatus.FORBIDDEN,
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const brand = (
        await tx
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
        await tx
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
        await tx.insert(recognitionEntries).values({
          brandId: brand.id,
          kind: 'competitor',
          name: c.name,
          aliases: [],
          note: c.note,
          source: 'ai',
          confirmed: false,
        });
      }
      await this.snapshotRecognitionTx(tx, brand.id);

      const limits = PLAN_LIMITS[plan];
      await tx.insert(subscriptions).values({
        accountId: input.accountId,
        brandId: brand.id,
        plan,
        questionQuota: { ranking: limits.rankingQuota, reputation: limits.reputationQuota },
        engineQuota: { web: limits.webEngines, app: limits.appEngines },
        freq: 1,
      });

      // 采集计划:网页端全引擎(免费版按档位引擎数,与 M0 交付对齐)
      const engines = WEB_ENGINES.slice(0, limits.webEngines);
      await tx.insert(collectionPlans).values({
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
    });
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

  /**
   * 品牌资料修改(品牌资产栏目):名称/行业/官网/描述。
   * 名称是识别匹配的本品词 —— 改名须同步本品口径条目并落口径版本快照,
   * 否则历史口径与采集匹配仍用旧名(docs/05 §2 品牌匹配)。
   */
  async update(
    accountId: number,
    brandId: number,
    patch: { name?: string; industry?: string; website?: string; intro?: string },
  ) {
    const brand = await this.getOwned(accountId, brandId);
    const next: Partial<{ name: string; industry: string; website: string; intro: string }> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new HttpException('品牌名不能为空', HttpStatus.BAD_REQUEST);
      if (name !== brand.name) {
        await this.db
          .update(recognitionEntries)
          .set({ name })
          .where(
            and(
              eq(recognitionEntries.brandId, brandId),
              eq(recognitionEntries.kind, 'self'),
              eq(recognitionEntries.name, brand.name),
            ),
          );
        await this.snapshotRecognition(brandId);
      }
      next.name = name;
    }
    if (patch.industry !== undefined) next.industry = patch.industry.trim() || null as never;
    if (patch.website !== undefined) next.website = patch.website.trim() || null as never;
    if (patch.intro !== undefined) next.intro = patch.intro.trim() || null as never;
    if (Object.keys(next).length === 0) return brand;

    return (
      await this.db.update(brands).set(next).where(eq(brands.id, brandId)).returning()
    )[0]!;
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

  /** 事务内快照(创建品牌路径使用,与口径写入同事务提交)。 */
  private async snapshotRecognitionTx(
    tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
    brandId: number,
  ) {
    const entries = await tx
      .select()
      .from(recognitionEntries)
      .where(eq(recognitionEntries.brandId, brandId));
    await tx.insert(recognitionVersions).values({
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
