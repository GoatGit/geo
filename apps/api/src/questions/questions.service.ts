import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { brands, collectionPlans, monitoringQuestions, recognitionEntries, subscriptions } from '@geo/db';
import { PLAN_LIMITS, type PlanTier, type QuestionType } from '@geo/shared';
import { DB, REDIS } from '../common/infra.module';

/** 问题分类与拓写的确定性基线(生产叠加 LLM,接口不变,docs/01 §3.2)。 */
export function classifyQuestion(text: string): QuestionType {
  const t = text.toLowerCase();
  const reputationWords = ['口碑', '质量', '评价', '怎么样', '吐槽', '投诉', '售后', '服务', '靠谱', '踩坑'];
  return reputationWords.some((w) => t.includes(w)) ? 'reputation' : 'ranking';
}

/** AI 拓写:短词 → 自然问法;保留原文与改写文两份(docs/01 §3.2)。 */
export function expandQuestion(text: string, brandName: string): string {
  const t = text.trim();
  if (/[?？]$/.test(t) && t.length >= 14) return t;
  if (/推荐|排行|哪些/.test(t))
    return `在可承受的预算内,${t.replace(/[?？]$/, '')},有什么值得推荐的吗?`;
  if (classifyQuestion(t) === 'reputation')
    return `${brandName}的口碑和质量到底怎么样?有什么优缺点?`;
  return `${t}——2026 年有什么值得关注的?`;
}

@Injectable()
export class QuestionsService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private async planOf(brandId: number, accountId: number) {
    const sub = (
      await this.db.select().from(subscriptions).where(eq(subscriptions.brandId, brandId)).limit(1)
    )[0];
    if (!sub || sub.accountId !== accountId) {
      throw new HttpException('品牌不存在或未订阅', HttpStatus.NOT_FOUND);
    }
    // 到期校验:订阅行没有自动到期降档任务,status 会一直停在 active——
    // 权益执行点必须自己看 periodEnd,否则过期套餐仍按付费档接受新增问题
    const expired = !sub.periodEnd || sub.periodEnd.getTime() <= Date.now();
    const plan: PlanTier = expired ? 'free' : (sub.plan as PlanTier);
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    return {
      plan,
      limits,
      quotas: expired
        ? { ranking: limits.rankingQuota, reputation: limits.reputationQuota }
        : (sub.questionQuota as { ranking: number; reputation: number }),
      brandName: (
        await this.db.select({ name: brands.name }).from(brands).where(eq(brands.id, brandId)).limit(1)
      )[0]?.name ?? '',
    };
  }

  /** 配额按类型分池(docs/00 教训 #4 对策),超额明确报错并给出升档指引。 */
  async batchCreate(input: {
    accountId: number;
    brandId: number;
    items: Array<{ text: string; type?: QuestionType }>;
  }) {
    const { limits, brandName } = await this.planOf(input.brandId, input.accountId);
    const created: Array<{ id: number; type: QuestionType; textRaw: string; textExpanded: string }> = [];
    const rejected: Array<{ text: string; reason: string }> = [];

    const used = { ranking: await this.used(input.brandId, 'ranking'), reputation: await this.used(input.brandId, 'reputation') };

    for (const item of input.items) {
      const type = item.type ?? classifyQuestion(item.text);
      const limit = type === 'ranking' ? limits.rankingQuota : limits.reputationQuota;
      if (used[type] >= limit) {
        rejected.push({
          text: item.text,
          reason: `${type === 'ranking' ? '排名词' : '口碑词'}配额已满(${used[type]}/${limit}),升档可增加问题位`,
        });
        continue;
      }
      const row = (
        await this.db
          .insert(monitoringQuestions)
          .values({
            brandId: input.brandId,
            type,
            textRaw: item.text,
            textExpanded: expandQuestion(item.text, brandName),
          })
          .returning()
      )[0]!;
      used[type] += 1;
      created.push({ id: row.id, type, textRaw: row.textRaw, textExpanded: row.textExpanded });
    }

    // 首次配置完成 → 触发首轮采集(教训 #3 对策:总览页显示预计完成时间)
    await this.db
      .update(collectionPlans)
      .set({ nextRunAt: sql`coalesce(${collectionPlans.nextRunAt}, now())` })
      .where(eq(collectionPlans.brandId, input.brandId));

    return {
      created,
      rejected,
      quota: {
        ranking: { used: used.ranking, limit: limits.rankingQuota },
        reputation: { used: used.reputation, limit: limits.reputationQuota },
      },
    };
  }

  async quotaOf(accountId: number, brandId: number) {
    const { plan, limits } = await this.planOf(brandId, accountId);
    return {
      plan,
      ranking: { used: await this.used(brandId, 'ranking'), limit: limits.rankingQuota },
      reputation: { used: await this.used(brandId, 'reputation'), limit: limits.reputationQuota },
    };
  }

  async list(accountId: number, brandId: number) {
    await this.planOf(brandId, accountId);
    return this.db
      .select()
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));
  }

  /** 删除=归档:历史数据保留,仅停止后续采集(docs/01 §3.2)。 */
  async deleteQuestion(accountId: number, brandId: number, questionId: number) {
    await this.planOf(brandId, accountId);
    await this.db
      .update(monitoringQuestions)
      .set({ status: 'archived' })
      .where(and(eq(monitoringQuestions.id, questionId), eq(monitoringQuestions.brandId, brandId)));
    return { archived: true };
  }

  async recognitionOf(brandId: number) {
    return this.db.select().from(recognitionEntries).where(eq(recognitionEntries.brandId, brandId));
  }

  private async used(brandId: number, type: QuestionType): Promise<number> {
    const row = (
      await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(monitoringQuestions)
        .where(
          and(
            eq(monitoringQuestions.brandId, brandId),
            eq(monitoringQuestions.type, type),
            eq(monitoringQuestions.status, 'active'),
          ),
        )
    )[0];
    return row?.n ?? 0;
  }
}
