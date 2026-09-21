import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  brands,
  loadPlatformSettings,
  personaPools,
  type PoolSpec,
  type PoolSpecSegment,
  personas,
  surveyResponses,
  surveys,
  type SurveyQuestion,
} from '@geo/db';
import { InsightAgent } from '@geo/insight-agent';
import { DB } from '../common/infra.module';

/**
 * 超级问卷(docs/11):LLM 生成问卷 → AI 建议人群 → 用户确认(approved 闸门) → 逐 persona 作答 → 报告。
 * 合成样本仅用于假设探索,报告必须携带合成声明;作答同步串行执行(MVP 规模 200-1000,吞吐可接受)。
 */

/** 按 docs/12 §2 的职业组→年龄×收入条件分布做确定性注入;MVP 用简化联合分布表。 */
function fillSegmentProfile(seg: PoolSpecSegment, seed: number): Record<string, unknown> {
  const pick = <T,>(arr: T[], offset: number): T => arr[(seed + offset) % arr.length];
  return {
    ageBand: seg.ageBand,
    cityTier: seg.cityTier,
    incomeBand: seg.incomeBand,
    gender: seg.gender === '不限' ? pick(['男', '女'], 1) : seg.gender,
    occupationGroup: seg.occupationGroup,
    // 行为属性交给作答时的 LLM;这里只放影响语气的稳定维度(确定性伪随机,可复现)
    priceSensitivity: pick(['低', '中', '高'], 2),
    style: pick(['理性对比型', '口碑从众型', '参数研究型', '体验直觉型'], 3),
  };
}

@Injectable()
export class SurveysService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  private async ownedSurvey(accountId: number, surveyId: number) {
    const row = (await this.db.select().from(surveys).where(eq(surveys.id, surveyId)).limit(1))[0];
    if (!row || row.accountId !== accountId) throw new HttpException('调研不存在', HttpStatus.NOT_FOUND);
    return row;
  }

  private async agent() {
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    return new InsightAgent({ settings: cfg });
  }

  /** S0:创建调研草稿(目标必填,题目可留空待生成)。 */
  async create(input: { accountId: number; brandId?: number; title: string; objective: string }) {
    if (input.brandId != null) {
      const brand = (await this.db.select().from(brands).where(eq(brands.id, input.brandId)).limit(1))[0];
      if (!brand || brand.accountId !== input.accountId) throw new HttpException('品牌不存在', HttpStatus.NOT_FOUND);
    }
    const row = (
      await this.db
        .insert(surveys)
        .values({ accountId: input.accountId, brandId: input.brandId ?? null, title: input.title, objective: input.objective })
        .returning()
    )[0];
    return row;
  }

  /** S1:LLM 生成问卷 + AI 建议人群;生成结果只写入草稿,用户可继续编辑(最终决策权)。 */
  async generateSurvey(input: { accountId: number; surveyId: number }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    if (survey.status === 'running' || survey.status === 'completed') {
      throw new HttpException('调研已进入运行/完成态,不可重新生成', HttpStatus.CONFLICT);
    }
    const brandName = survey.brandId
      ? (await this.db.select().from(brands).where(eq(brands.id, survey.brandId)).limit(1))[0]?.name
      : undefined;
    const result = await (await this.agent()).generateSurvey({ objective: survey.objective, brandName });
    if (!result) throw new HttpException('问卷生成失败(LLM 不可用或输出不合法)', HttpStatus.BAD_GATEWAY);
    const updated = (
      await this.db
        .update(surveys)
        .set({ questions: result.questions, status: 'ready_selecting', updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning()
    )[0];
    return { survey: updated, suggestedSegments: result.segments, parserVersion: result.parserVersion };
  }

  /** 用户编辑问卷题目(最终决策权落在数据上)。 */
  async updateQuestions(input: { accountId: number; surveyId: number; questions: SurveyQuestion[] }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    if (survey.status === 'running' || survey.status === 'completed') {
      throw new HttpException('调研已进入运行/完成态,不可修改问卷', HttpStatus.CONFLICT);
    }
    return (
      await this.db
        .update(surveys)
        .set({ questions: input.questions, updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning()
    )[0];
  }

  /** S2:按配额骨架实例化人群池(生成/抽样 personas);approved 仍为 false,等用户确认。 */
  async createPool(input: { accountId: number; surveyId: number; spec: PoolSpec }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    if (!survey.questions.length) throw new HttpException('请先生成/填写问卷', HttpStatus.CONFLICT);
    const total = input.spec.segments.reduce((s, x) => s + x.count, 0);
    if (total <= 0 || total > 2000) throw new HttpException('人群总量需在 1..2000', HttpStatus.BAD_REQUEST);

    const pool = (
      await this.db.insert(personaPools).values({ surveyId: survey.id, spec: input.spec, size: total }).returning()
    )[0];
    const rows: Array<{ poolId: number; profile: Record<string, unknown>; source: string }> = [];
    let seed = 0;
    for (const seg of input.spec.segments) {
      for (let i = 0; i < seg.count; i++) {
        rows.push({ poolId: pool.id, profile: fillSegmentProfile(seg, seed++), source: 'generated' });
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      await this.db.insert(personas).values(rows.slice(i, i + 200));
    }
    await this.db.update(surveys).set({ status: 'ready_selecting', updatedAt: new Date() }).where(eq(surveys.id, survey.id));
    return { poolId: pool.id, size: total };
  }

  /** S2 决策闸门:approved=true 之后才能 run。 */
  async approvePool(input: { accountId: number; surveyId: number; poolId: number; approved: boolean }) {
    await this.ownedSurvey(input.accountId, input.surveyId);
    const pool = (await this.db.select().from(personaPools).where(eq(personaPools.id, input.poolId)).limit(1))[0];
    if (!pool || pool.surveyId !== input.surveyId) throw new HttpException('人群池不存在', HttpStatus.NOT_FOUND);
    return (
      await this.db.update(personaPools).set({ approved: input.approved }).where(eq(personaPools.id, pool.id)).returning()
    )[0];
  }

  /** S3:运行作答。前置:问卷非空 + 池已 approved;逐 persona 串行调用,单条失败不阻断整体。 */
  async run(input: { accountId: number; surveyId: number }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    if (!survey.questions.length) throw new HttpException('问卷为空', HttpStatus.CONFLICT);
    const pool = (await this.db.select().from(personaPools).where(eq(personaPools.surveyId, survey.id)).limit(1))[0];
    if (!pool || !pool.approved) throw new HttpException('人群池未经用户确认,禁止运行', HttpStatus.CONFLICT);
    if (survey.status === 'running') throw new HttpException('调研正在运行', HttpStatus.CONFLICT);

    await this.db.update(surveys).set({ status: 'running', updatedAt: new Date() }).where(eq(surveys.id, survey.id));
    const agent = await this.agent();
    if (!agent.usable) {
      await this.db.update(surveys).set({ status: 'failed', updatedAt: new Date() }).where(eq(surveys.id, survey.id));
      throw new HttpException('LLM 未配置,无法作答', HttpStatus.BAD_GATEWAY);
    }
    const people = await this.db.select().from(personas).where(eq(personas.poolId, pool.id)).orderBy(asc(personas.id));
    let ok = 0;
    let fail = 0;
    for (const p of people) {
      const res = await agent.personaAnswer({ profile: p.profile, questions: survey.questions });
      if (!res) {
        fail += 1;
        continue;
      }
      await this.db
        .insert(surveyResponses)
        .values({
          surveyId: survey.id,
          personaId: p.id,
          answers: res.answers,
          model: res.parserVersion,
          parserVersion: res.parserVersion,
        })
        .onConflictDoNothing();
      ok += 1;
    }
    const done = (
      await this.db
        .update(surveys)
        .set({ status: ok > 0 ? 'completed' : 'failed', updatedAt: new Date() })
        .where(eq(surveys.id, survey.id))
        .returning()
    )[0];
    return { ok, fail, status: done.status };
  }

  async list(accountId: number) {
    return this.db.select().from(surveys).where(eq(surveys.accountId, accountId)).orderBy(asc(surveys.id));
  }

  /** S4:加权聚合报告;头部固定合成声明(docs/11 §5 诚实性设计)。 */
  async report(accountId: number, surveyId: number) {
    const survey = await this.ownedSurvey(accountId, surveyId);
    const rows = await this.db
      .select({ answers: surveyResponses.answers, weight: personas.weight, poolSpec: personaPools.spec })
      .from(surveyResponses)
      .innerJoin(personas, eq(surveyResponses.personaId, personas.id))
      .innerJoin(personaPools, eq(personas.poolId, personaPools.id))
      .where(and(eq(surveyResponses.surveyId, survey.id), eq(personaPools.surveyId, survey.id)));
    if (!rows.length) throw new HttpException('尚无作答数据', HttpStatus.NOT_FOUND);

    const perQuestion: Record<string, { counts: Record<string, number>; weightedTotal: number; openTexts: string[] }> = {};
    for (const r of rows) {
      for (const a of r.answers) {
        const bucket = (perQuestion[a.questionId] ??= { counts: {}, weightedTotal: 0, openTexts: [] });
        const key = Array.isArray(a.answer) ? a.answer.slice().sort().join('|') : String(a.answer);
        bucket.counts[key] = (bucket.counts[key] ?? 0) + r.weight;
        bucket.weightedTotal += r.weight;
        if (typeof a.answer === 'string' && a.answer.length > 0) bucket.openTexts.push(a.answer);
      }
    }
    const questions = survey.questions.map((q) => {
      const b = perQuestion[q.id];
      const distribution: Array<{ value: string; share: number }> = [];
      if (b) {
        for (const [value, w] of Object.entries(b.counts)) {
          distribution.push({ value, share: b.weightedTotal > 0 ? w / b.weightedTotal : 0 });
        }
        distribution.sort((x, y) => y.share - x.share);
      }
      return { question: q, distribution, responses: b ? b.openTexts.slice(0, 50) : [] };
    });
    return {
      disclaimer: `合成样本报告(N=${rows.length},加权统计):仅用于假设探索与问卷预筛选,不构成市场结论;重要决策需真人样本验证。`,
      status: survey.status,
      questions,
    };
  }

  async pools(accountId: number, surveyId: number) {
    await this.ownedSurvey(accountId, surveyId);
    return this.db.select().from(personaPools).where(eq(personaPools.surveyId, surveyId)).orderBy(asc(personaPools.id));
  }
}
