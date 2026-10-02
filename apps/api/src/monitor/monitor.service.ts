import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  brands,
  citationFacts,
  dailyMetrics,
  latestOkRuns,
  mentionFacts,
  monitoringQuestions,
  queryRuns,
  reputationFacts,
} from '@geo/db';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  THRESHOLD_CALIBRATION_GRACE_DAYS,
  engineLabel,
  sanitizeCitationTitle,
  type EngineId,
  type FunnelStage,
  type MatrixRow,
  type MetricCard,
  type MetricSource,
} from '@geo/shared';
import { bestCellPerEngine, classifyDomain, evaluateHealth, generateActionList, isAuthoritativeCategory, overlayTailSubjects, sentimentScore as sentimentScoreOf } from '@geo/metrics';
import Redis from 'ioredis';
import { chatCompletion, InsightAgent } from '@geo/insight-agent';
import { createStorageFromEnv } from '@geo/evidence';
import { siteConfigOf, stripAnswerNoise, stripInlineCitationMarkers } from '@geo/engine-adapters';
import { loadPlatformSettings } from '@geo/db';
import type { ActionItem } from '@geo/shared';
import { DB, REDIS } from '../common/infra.module';

/**
 * 指标服务唯一供数出口(docs/02 §8 制度保障):
 * 任何页面/报告禁止绕开本服务直连原始表聚合。
 * 所有指标携带 分子/分母 + excluded(failed/quota_blocked) + asOf + source。
 */
@Injectable()
export class MonitorService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 排名透视聚合 DTO(docs/01 §3.3):指标卡 + 矩阵 + 漏斗 + 引擎分化 + 健康。 */
  async rankings(input: { brandId: number; days: number; engine?: EngineId }) {
    const direct = await this.rankingsWindow(input);
    // 所选窗口无有效数据 → 依序回落更大窗口(docs/02 §8:无数据回退最近完成日,
    // 旧数据必须保留展示;今日采集中断/被拦截时页面不能看起来像数据被清空)
    const validOf = (r: Awaited<ReturnType<MonitorService['rankingsWindow']>>) =>
      r.cards[0]?.denominator ?? 0;
    if (validOf(direct) > 0 || input.days >= 30) return direct;
    for (const d of [7, 30].filter((x) => x > input.days)) {
      const alt = await this.rankingsWindow({ ...input, days: d });
      if (validOf(alt) > 0) {
        return {
          ...alt,
          fallback: {
            requestedDays: input.days,
            actualDays: d,
            quotaBlocked: direct.excluded.quotaBlocked,
            failed: direct.excluded.failed,
          },
        };
      }
    }
    return direct;
  }

  /**
   * 有效口径事实集(docs/02 §1.1.1):窗口内全部 self 事实 ∪ 窗口缺席对的最近一次有效 run 事实。
   * 指标卡/漏斗/分引擎三率/竞品本品侧/体检引用源统一用它统计;
   * 趋势(时间序列)与 excluded(采集事件)仍按窗口,不回填。
   */
  private async effectiveSelfFacts(brandId: number, since: Date) {
    const windowFacts = await this.db
      .select({
        questionId: mentionFacts.questionId,
        engine: mentionFacts.engine,
        mentioned: mentionFacts.mentioned,
        rank: mentionFacts.rank,
        runId: mentionFacts.runId,
        ranAt: mentionFacts.ranAt,
      })
      .from(mentionFacts)
      .where(and(eq(mentionFacts.brandId, brandId), gte(mentionFacts.ranAt, since), eq(mentionFacts.subjectKind, 'self')));
    const { tail } = await latestOkRuns(this.db, brandId, since);
    const tailRunIds = [...tail.values()].map((r) => r.runId);
    let effective = windowFacts;
    let backfilled = 0;
    if (tailRunIds.length > 0) {
      const windowPairs = new Set(windowFacts.map((f) => `${f.questionId}|${f.engine}`));
      const tailFacts = await this.db
        .select({
          questionId: mentionFacts.questionId,
          engine: mentionFacts.engine,
          mentioned: mentionFacts.mentioned,
          rank: mentionFacts.rank,
          runId: mentionFacts.runId,
          ranAt: mentionFacts.ranAt,
        })
        .from(mentionFacts)
        .where(
          and(eq(mentionFacts.brandId, brandId), eq(mentionFacts.subjectKind, 'self'), inArray(mentionFacts.runId, tailRunIds)),
        );
      const add = tailFacts.filter((f) => !windowPairs.has(`${f.questionId}|${f.engine}`));
      backfilled = add.length;
      effective = [...windowFacts, ...add];
    }
    return { effective, backfilled, tailRunIds };
  }

  private async rankingsWindow(input: { brandId: number; days: number; engine?: EngineId }) {
    const since = new Date(Date.now() - input.days * 24 * 3600 * 1000);

    // 总览统计改走有效口径(窗口 ∪ 尾部补齐,docs/02 §1.1.1),与矩阵逐条数据同源
    const activeIds = new Set(
      (
        await this.db
          .select({ id: monitoringQuestions.id })
          .from(monitoringQuestions)
          .where(and(eq(monitoringQuestions.brandId, input.brandId), eq(monitoringQuestions.status, 'active')))
      ).map((r) => r.id),
    );
    const { effective, backfilled, tailRunIds } = await this.effectiveSelfFacts(input.brandId, since);
    const factList = (input.engine ? effective.filter((f) => f.engine === input.engine) : effective).filter((f) =>
      activeIds.has(f.questionId),
    );
    const valid = factList.length;
    const mentioned = factList.filter((f) => f.mentioned).length;
    const top3 = factList.filter((f) => f.mentioned && f.rank !== null && f.rank <= 3).length;
    const top1 = factList.filter((f) => f.mentioned && f.rank === 1).length;
    const rankedFacts = factList.filter((f) => f.mentioned && f.rank !== null);
    const ranked = rankedFacts.length;
    const avgRankValue = ranked > 0 ? rankedFacts.reduce((a, f) => a + (f.rank ?? 0), 0) / ranked : null;
    const t = { avg_rank: avgRankValue != null ? String(avgRankValue) : null } as Record<string, string | null>;

    // excluded = failed/quota_blocked(docs/02 §1.1:失败/拦截在任何页面不得体现为 0 值)
    const excluded = await this.db.execute(sql`
      select
        count(*) filter (where qr.status = 'failed')        as failed,
        count(*) filter (where qr.status = 'quota_blocked') as quota_blocked
      from query_runs qr
      where qr.brand_id = ${input.brandId} and qr.ran_at >= ${since}
        ${input.engine ? sql`and qr.engine = ${input.engine}` : sql``}
    `);
    const ex = (excluded.rows[0] ?? {}) as Record<string, string | null>;

    const asOf = new Date().toISOString();
    const source: MetricSource = 'realtime';
    const rate = (n: number, d: number | null) => (d && d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    const nEx = { failed: Number(ex.failed ?? 0), quotaBlocked: Number(ex.quota_blocked ?? 0) };

    const cards: MetricCard[] = [
      this.card('mentionRate', rate(mentioned, valid), mentioned, valid, nEx, asOf, source,
        '窗口内有效采集 + 最近有效回填(ok_with_answer + ok_empty)', backfilled),
      this.card('top3Rate', rate(top3, ranked), top3, ranked, nEx, asOf, source,
        '有名次的采集(含回填;含散文提及中判出位次;漏斗②用"被提及"作分母,口径不同勿直接对比)', backfilled),
      this.card('top1Rate', rate(top1, ranked), top1, ranked, nEx, asOf, source,
        '有名次的采集(含回填)', backfilled),
      {
        metric: 'avgRank',
        value: t.avg_rank ? Math.round(Number(t.avg_rank) * 100) / 100 : null,
        numerator: ranked,
        denominator: ranked,
        excludedFailed: nEx.failed,
        excludedQuotaBlocked: nEx.quotaBlocked,
        backfilled,
        asOf,
        source,
      },
    ];

    const matrix = await this.matrix(input.brandId, since);

    // 可见性漏斗:嵌套转化口径(docs/02 §2,2026-09 修订);有效口径(含回填)
    const funnel: FunnelStage[] = [
      stage('mention', '提及', mentioned, valid, '全部有效采集+最近有效回填(ok_with_answer + ok_empty)'),
      stage('top3', '上榜(Top3)', top3, mentioned, '①的分子:被提及的采集(含回填)'),
      stage('top1', '首推(位次=1)', top1, top3, '②的分子:进 Top3 的采集(含回填)'),
    ];

    const trend = await this.trend(input.brandId, 7); // 迷你趋势固定近 7 天,不受所选周期影响

    // ===== 品牌洞察图表(rubric 迁移):问题层→结局桑基 + 本品 vs 行业均值 =====
    const layerSankey = await this.layerSankey(input.brandId, since, effective);
    const benchmark = await this.benchmark(input.brandId, since, { mentioned, top3, top1, valid, ranked });

    const calibrating = await this.inCalibrationWindow(input.brandId);
    // 情绪/信源类体检实时口径:按引用类别聚合一次,自有占比与权威信源引用率同源计算(docs/02 §3)
    const rep = await this.reputation(input.brandId, input.days);
    const citeRows = await this.db
      .select({
        category: citationFacts.platformCategory,
        n: sql<number>`count(*)::int`,
        owned: sql<number>`count(*) filter (where ${citationFacts.isOwned})::int`,
      })
      .from(citationFacts)
      .where(
        tailRunIds.length > 0
          ? and(
              eq(citationFacts.brandId, input.brandId),
              or(gte(citationFacts.extractedAt, since), inArray(citationFacts.runId, tailRunIds)),
            )
          : and(eq(citationFacts.brandId, input.brandId), gte(citationFacts.extractedAt, since)),
      )
      .groupBy(citationFacts.platformCategory);
    let citeTotal = 0;
    let citeOwned = 0;
    let citeAuthoritative = 0;
    for (const r of citeRows) {
      citeTotal += r.n;
      citeOwned += r.owned;
      if (isAuthoritativeCategory(r.category)) citeAuthoritative += r.n;
    }
    const ownedShare = citeTotal > 0 ? citeOwned / citeTotal : null;
    const authoritativeShare = citeTotal > 0 ? citeAuthoritative / citeTotal : null;
    const health = evaluateHealth(
      {
        mentionRate: cards[0]!.value,
        top3Rate: cards[1]!.value,
        top1Rate: cards[2]!.value,
        avgRank: cards[3]!.value,
        sentimentScore: rep.totals.hasData ? rep.totals.sentimentScore : null,
        ownedCitationShare: ownedShare,
        ownedCitationCount: citeOwned,
        authoritativeCitationShare: authoritativeShare,
        authoritativeCitationCount: citeAuthoritative,
      },
      DEFAULT_HEALTH_THRESHOLDS,
      calibrating,
    );

    return {
      cards,
      funnel,
      matrix,
      engineStats: await this.engineRates(input.brandId, since, effective),
      trend,
      health,
      excluded: nEx,
      period: { days: input.days, since: since.toISOString(), backfilled },
      asOf,
      source,
      layerSankey,
      benchmark,
    };
  }

  /**
   * 问题层→转化结局 桑基数据(单品牌):每层问题被提及/进Top3/被首推/缺席的次数。
   * 数据源 = 有效口径事实集(窗口∪回填,docs/02 §1.1.1,与矩阵同源);无分层的问题归「未分层」。
   */
  private async layerSankey(
    brandId: number,
    since: Date,
    precomputed?: Array<{ questionId: number; mentioned: boolean; rank: number | null }>,
  ) {
    const facts = precomputed ?? (await this.effectiveSelfFacts(brandId, since)).effective;
    const questions = await this.db
      .select({ id: monitoringQuestions.id, groupName: monitoringQuestions.groupName })
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));
    const layerOfQuestion = new Map(questions.map((q) => [q.id, q.groupName ?? '未分层']));
    const byLayer = new Map<string, { asked: number; mentioned: number; top3: number; top1: number }>();
    for (const f of facts) {
      const layer = layerOfQuestion.get(f.questionId);
      if (!layer) continue; // 非本品牌活跃问题的事实不计入
      const e = byLayer.get(layer) ?? { asked: 0, mentioned: 0, top3: 0, top1: 0 };
      e.asked += 1;
      if (f.mentioned) {
        e.mentioned += 1;
        if (f.rank !== null && f.rank <= 3) e.top3 += 1;
        if (f.rank === 1) e.top1 += 1;
      }
      byLayer.set(layer, e);
    }
    return [...byLayer.entries()]
      .filter(([, e]) => e.asked > 0)
      .map(([layer, e]) => ({
        layer,
        asked: e.asked,
        mentioned: e.mentioned,
        top3: e.top3,
        top1: e.top1,
        missed: e.asked - e.mentioned,
      }));
  }

  /**
   * 历史排名重判(2026-09-21 首位评述口径,b719d02):
   * 扫描本品牌 mentioned=true 且 rank=null 的 run,取回答原文用新判定语义重判,
   * 仅允许 null → 有值 的升级(不降级已有位次)。dryRun 只报告不写库。
   */
  async backfillRanks(
    accountId: number,
    brandId: number,
    opts: { dryRun?: boolean; limit?: number; resetChecked?: boolean },
  ): Promise<{ scanned: number; changedRuns: number; changedFacts: number; failed: number; dryRun: boolean; sample: string[]; lastError: string | null }> {
    await this.brandsOwned(accountId, brandId);
    const settings = (await loadPlatformSettings(this.db)).insightAgent;
    if (!settings.enabled || settings.mode === 'rules' || !settings.endpoint || !settings.apiKey || !settings.model) {
      throw new Error('Insight Agent 未启用,无法重判(请先在管理后台配置)');
    }
    const agent = new InsightAgent({ settings });
    const storage = createStorageFromEnv(process.env);
    const limit = Math.min(Math.max(opts.limit ?? 120, 1), 300);
    // 重试模式:清除已查标记,让判定失败(LLM 超时/限流)的 run 重新参与
    if (opts.resetChecked) {
      await this.db.execute(sql`
        update query_runs qr
        set meta = meta - 'rankBackfillChecked'
        where qr.brand_id = ${brandId}
          and coalesce(qr.meta->>'rankBackfillChecked', 'false') = 'true'
          and exists (
            select 1 from mention_facts mf
            where mf.run_id = qr.id and mf.mentioned = true and mf.rank is null
          )
      `);
    }

    const runs = (
      await this.db.execute(sql`
        select distinct qr.id, qr.answer_ref, qr.engine, q.text_expanded as question
        from mention_facts mf
        join query_runs qr on qr.id = mf.run_id
        join monitoring_questions q on q.id = mf.question_id
        where mf.brand_id = ${brandId} and mf.mentioned = true and mf.rank is null
          and qr.answer_ref is not null
          and coalesce(qr.meta->>'rankBackfillChecked', 'false') <> 'true'
        order by qr.id desc
        limit ${limit}
      `)
    ).rows as unknown as Array<{ id: number; answer_ref: string; engine: string; question: string }>;

    let changedRuns = 0;
    let changedFacts = 0;
    let failed = 0;
    let lastError: string | null = null;
    const sample: string[] = [];

    for (const run of runs) {
      try {
        const facts = (
          await this.db.execute(sql`
            select id, subject_key, subject_kind, subject_name, rank
            from mention_facts where run_id = ${run.id}
          `)
        ).rows as unknown as Array<{ id: number; subject_key: string; subject_kind: string; subject_name: string; rank: number | null }>;
        // 判定前净化:历史文心/DeepSeek 回答含搜索状态行+引用源编号列表,
        // 会让 LLM 不认「首位评述」且可能把引用顺序误读为排位
        const rawAnswer = (JSON.parse((await storage.get(run.answer_ref)).toString('utf8')).answerText ?? '') as string;
        let cleanAnswer = stripInlineCitationMarkers(rawAnswer);
        try {
          cleanAnswer = stripAnswerNoise(siteConfigOf(run.engine as never), cleanAnswer);
        } catch {
          // 未知引擎:仅内联角标剥离
        }
        const judged = await agent.judgeMention({
          question: run.question,
          answerMarkdown: cleanAnswer,
          subjects: facts.map((f) => ({ key: f.subject_key, kind: f.subject_kind, name: f.subject_name, aliases: [] })),
        });
        if (!judged) {
          // 判定失败(LLM 超时/限流):不打标,下次批处理重试
          failed += 1;
          continue;
        }
        // 判定成功才打标:语义正确的 null 不会被反复重扫
        await this.db.execute(sql`
          update query_runs
          set meta = coalesce(meta, '{}'::jsonb) || '{"rankBackfillChecked":"true"}'::jsonb
          where id = ${run.id}
        `);
        const updates: Array<{ id: number; name: string; rank: number }> = [];
        for (const j of judged.judges) {
          if (j.rank == null || !j.mentioned) continue;
          const fact = facts.find((f) => f.subject_key === j.key);
          if (fact && fact.rank == null) updates.push({ id: fact.id, name: j.name, rank: j.rank });
        }
        if (updates.length === 0) continue;
        changedRuns += 1;
        changedFacts += updates.length;
        if (sample.length < 8) sample.push(`run #${run.id}: ${updates.map((u) => `${u.name}=第${u.rank}`).join(', ')}`);
        if (!opts.dryRun) {
          for (const u of updates) {
            try {
              await this.db.execute(sql`update mention_facts set rank = ${u.rank}, confidence = 0.9 where id = ${u.id}`);
            } catch (err) {
            lastError = `update fact ${u.id}: ${(err as Error).message.slice(0, 200)}`;
            break;
          }
          }
        }
      } catch {
        failed += 1;
      }
    }
    return { scanned: runs.length, changedRuns, changedFacts, failed, dryRun: Boolean(opts.dryRun), sample, lastError };
  }

  private async brandsOwned(accountId: number, brandId: number): Promise<void> {
    const brand = (await this.db.select({ accountId: brands.accountId }).from(brands).where(eq(brands.id, brandId)).limit(1))[0];
    if (!brand || brand.accountId !== accountId) throw new Error('品牌不存在或无权操作');
  }

  /**
   * 本品 vs 行业均值(品牌所属行业的全部监测品牌,含竞品;只出均值不暴露他牌明细)。
   * 品牌无行业归属时各均值返回 null(前端隐藏对比)。
   */
  private async benchmark(
    brandId: number,
    since: Date,
    self: { mentioned: number; top3: number; top1: number; valid: number; ranked: number },
  ) {
    const brand = (await this.db.select({ industry: brands.industry }).from(brands).where(eq(brands.id, brandId)).limit(1))[0];
    if (!brand?.industry) {
      return { industry: null, mentionRate: null, top3Rate: null, top1Rate: null, brandCount: 0, selfMentionRate: self.ranked > 0 || self.valid > 0 ? Math.round((self.mentioned / Math.max(self.valid, 1)) * 1000) / 1000 : null };
    }
    const agg = (await this.db.execute(sql`
      select count(*) filter (where true) as valid,
             count(*) filter (where mf.mentioned) as mentioned,
             count(*) filter (where mf.mentioned and mf.rank <= 3) as top3,
             count(*) filter (where mf.mentioned and mf.rank = 1) as top1
      from mention_facts mf
      join brands b on b.id = mf.brand_id
      where b.industry = ${brand.industry} and mf.ran_at >= ${since}
        and mf.subject_kind = 'self'
    `)) as unknown as { rows: Array<{ valid: string; mentioned: string; top3: string; top1: string }> };
    const a = agg.rows[0];
    const valid = Number(a?.valid ?? 0);
    const mentioned = Number(a?.mentioned ?? 0);
    const top3 = Number(a?.top3 ?? 0);
    const top1 = Number(a?.top1 ?? 0);
    const rate = (n: number) => (valid > 0 ? Math.round((n / valid) * 1000) / 1000 : null);
    const brandsIn = (await this.db.execute(sql`
      select count(*)::int as n from brands where industry = ${brand.industry}
    `)) as unknown as { rows: Array<{ n: number }> };
    return {
      industry: brand.industry,
      mentionRate: rate(mentioned),
      top3Rate: rate(top3),
      top1Rate: rate(top1),
      brandCount: brandsIn.rows[0]?.n ?? 0,
      selfMentionRate: self.valid > 0 ? Math.round((self.mentioned / self.valid) * 1000) / 1000 : null,
    };
  }

  /** 引擎×问题位次矩阵:行尾综合名次 = 未上榜记 N+1 取中位数(docs/02 §1.3)。 */
  async matrix(brandId: number, since: Date): Promise<MatrixRow[]> {
    const questions = await this.db
      .select({ id: monitoringQuestions.id, text: monitoringQuestions.textExpanded })
      .from(monitoringQuestions)
      .where(and(eq(monitoringQuestions.brandId, brandId), eq(monitoringQuestions.status, 'active')));

    const windowMs = Date.now() - since.getTime();
    const prevSince = new Date(since.getTime() - windowMs);
    const facts = await this.db
      .select({
        questionId: mentionFacts.questionId,
        engine: mentionFacts.engine,
        mentioned: mentionFacts.mentioned,
        rank: mentionFacts.rank,
        runId: mentionFacts.runId,
        ranAt: mentionFacts.ranAt,
      })
      .from(mentionFacts)
      .where(
        and(
          eq(mentionFacts.brandId, brandId),
          gte(mentionFacts.ranAt, prevSince),
          eq(mentionFacts.subjectKind, 'self'),
        ),
      );

    // 当前窗口 vs 上一窗口(环比 ▲▼):双层 Map(question×engine)
    const byQuestionPrev = new Map<number, typeof facts>();
    const byQuestion = new Map<number, typeof facts>();
    for (const f of facts) {
      const bucket = f.ranAt >= since ? byQuestion : byQuestionPrev;
      const arr = bucket.get(f.questionId) ?? [];
      arr.push(f);
      bucket.set(f.questionId, arr);
    }

    // 上一窗口最好位次(问题×引擎),用于环比标记
    const prevBest = new Map<string, { mentioned: boolean; rank: number | null }>();
    for (const [qid, fs] of byQuestionPrev) {
      const per = new Map<string, { mentioned: boolean; rank: number | null }>();
      for (const f of fs) {
        const prev = per.get(f.engine);
        const better =
          !prev || (f.mentioned && !prev.mentioned) || (f.mentioned && f.rank !== null && (prev.rank === null || f.rank < prev.rank));
        if (better) per.set(f.engine, { mentioned: f.mentioned, rank: f.rank });
      }
      for (const [engine, v] of per) prevBest.set(`${qid}|${engine}`, v);
    }

    // 尾部补齐(docs/02 §1):窗口内无 ok run 的问题×引擎,回填其最近一次有效 run 的 self 事实
    const { tail } = await latestOkRuns(this.db, brandId, since);
    const tailByQuestion = new Map<number, Array<{ engine: string; mentioned: boolean; rank: number | null; runId: number; ranAt: Date }>>();
    if (tail.size > 0) {
      const tailRunIds = [...tail.values()].map((r) => r.runId);
      const tailFacts = await this.db
        .select({
          questionId: mentionFacts.questionId,
          engine: mentionFacts.engine,
          mentioned: mentionFacts.mentioned,
          rank: mentionFacts.rank,
          runId: mentionFacts.runId,
          ranAt: mentionFacts.ranAt,
        })
        .from(mentionFacts)
        .where(and(eq(mentionFacts.brandId, brandId), eq(mentionFacts.subjectKind, 'self'), inArray(mentionFacts.runId, tailRunIds)));
      for (const f of tailFacts) {
        const arr = tailByQuestion.get(f.questionId) ?? [];
        arr.push(f);
        tailByQuestion.set(f.questionId, arr);
      }
    }

    const rows: MatrixRow[] = questions.map((q) => {
      const fs = byQuestion.get(q.id) ?? [];
      // 每引擎取窗口内最好位次(同名问题多轮次取更优,趋势用日结层);
      // 窗口完全缺席的引擎回填最近一次有效 run 的数据(窗口严格优先,stale 标记)
      const perEngine = bestCellPerEngine(fs, tailByQuestion.get(q.id) ?? []);
      const cells = [...perEngine.values()].map((v) => {
        const pb = prevBest.get(`${q.id}|${v.engine}`);
        return {
          engine: v.engine as EngineId,
          surface: 'web' as const,
          status: 'ok_with_answer' as const,
          mentioned: v.mentioned,
          rank: v.rank,
          /** 最佳位次那次采集的 runId(点击单元格回溯 AI 原文快照) */
          runId: v.runId ?? null,
          /** 上一窗口最好位次(环比 ▲▼ 标记;null=上期无数据) */
          prevRank: pb ? pb.rank : null,
          prevMentioned: pb ? pb.mentioned : null,
          /** 单元格数据采集时间(回填=最近一次有效 run;前端展示"N 天前") */
          asOf: v.ranAt.toISOString(),
          stale: v.stale,
        };
      });
      const collected = cells.length;
      const normalized = cells.map((c) => (c.mentioned && c.rank !== null ? c.rank : collected + 1));
      const sorted = [...normalized].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const compositeRank =
        sorted.length === 0
          ? null
          : sorted.length % 2 === 1
            ? sorted[mid]
            : Math.ceil((sorted[mid - 1]! + sorted[mid]!) / 2);
      const top3Engines = cells.filter((c) => c.mentioned && c.rank !== null && c.rank <= 3).length;
      // 行级三率(与竞品全景矩阵同口径):分母 = 实际参采引擎数
      const rates = {
        mentionRate: collected > 0 ? Math.round((cells.filter((c) => c.mentioned).length / collected) * 1000) / 1000 : null,
        top3Rate: collected > 0 ? Math.round((top3Engines / collected) * 1000) / 1000 : null,
        top1Rate:
          collected > 0 ? Math.round((cells.filter((c) => c.mentioned && c.rank === 1).length / collected) * 1000) / 1000 : null,
      };

      return {
        questionId: q.id,
        ...rates,
        questionText: q.text,
        cells,
        compositeRank,
        layer: layerOf(top3Engines, collected),
      };
    });
    return rows.sort((a, b) => (a.compositeRank ?? 999) - (b.compositeRank ?? 999));
  }

  /** 按日趋势(迷你图数据源,docs/01 §3.3 指标卡近 7/30 天迷你趋势)。 */
  async trend(brandId: number, days: number) {
    const since = new Date(Date.now() - Math.min(days, 30) * 24 * 3600 * 1000);
    const res = await this.db.execute(sql`
      select
        date_trunc('day', mf.ran_at)::date as d,
        count(*)                                              as valid,
        count(*) filter (where mf.mentioned)                  as mentioned,
        count(*) filter (where mf.mentioned and mf.rank <= 3) as top3,
        count(*) filter (where mf.mentioned and mf.rank = 1)  as top1,
        count(*) filter (where mf.mentioned and mf.rank is not null) as ranked
      from mention_facts mf
      where mf.brand_id = ${brandId} and mf.ran_at >= ${since} and mf.subject_kind = 'self'
      group by 1 order by 1
    `);
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    return res.rows.map((r) => {
      const row = r as Record<string, string>;
      const valid = Number(row.valid);
      const ranked = Number(row.ranked ?? 0);
      return {
        date: String(row.d),
        mentionRate: rate(Number(row.mentioned), valid),
        top3Rate: rate(Number(row.top3), ranked),
        top1Rate: rate(Number(row.top1), ranked),
      };
    });
  }

  /** 竞品×引擎 分引擎对比矩阵(docs/01 §3.4)。 */
  async competitorsMatrix(brandId: number, days: number, topN = 8) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const res = await this.db.execute(sql`
      select
        mf.subject_key, mf.subject_name, mf.engine,
        count(*)                                              as runs,
        count(*) filter (where mf.mentioned)                  as mentions,
        count(*) filter (where mf.mentioned and mf.rank <= 3) as top3
      from mention_facts mf
      where mf.brand_id = ${brandId} and mf.ran_at >= ${since}
        and mf.subject_kind in ('competitor', 'discovered')
      group by mf.subject_key, mf.subject_name, mf.engine
    `);
    const bySubject = new Map<string, { key: string; name: string; engines: Map<string, { runs: number; mentions: number; top3: number }> }>();
    const windowPairs = new Set<string>();
    for (const r of res.rows) {
      const row = r as Record<string, string>;
      let subj = bySubject.get(row.subject_key);
      if (!subj) {
        subj = { key: row.subject_key, name: row.subject_name, engines: new Map() };
        bySubject.set(row.subject_key, subj);
      }
      windowPairs.add(`${row.subject_key}|${row.engine}`);
      const prev = subj.engines.get(row.engine) ?? { runs: 0, mentions: 0, top3: 0 };
      prev.runs += Number(row.runs);
      prev.mentions += Number(row.mentions);
      prev.top3 += Number(row.top3);
      subj.engines.set(row.engine, prev);
    }
    // 尾部补齐:窗口内未出现的 主体×引擎 对,回填最近一次有效 run 的样本(主体行带 lastSeen)
    const lastSeenBySubject = new Map<string, Date>();
    const { tail } = await latestOkRuns(this.db, brandId, since);
    if (tail.size > 0) {
      const tailRunIds = [...tail.values()].map((r) => r.runId);
      const tailRes = await this.db
        .select({
          subjectKey: mentionFacts.subjectKey,
          subjectName: mentionFacts.subjectName,
          engine: mentionFacts.engine,
          mentioned: mentionFacts.mentioned,
          rank: mentionFacts.rank,
          ranAt: mentionFacts.ranAt,
        })
        .from(mentionFacts)
        .where(
          and(
            eq(mentionFacts.brandId, brandId),
            inArray(mentionFacts.runId, tailRunIds),
            inArray(mentionFacts.subjectKind, ['competitor', 'discovered']),
          ),
        );
      const { added, lastSeenAt } = overlayTailSubjects(
        windowPairs,
        tailRes.map((f) => ({ ...f, rank: f.rank ?? null })),
      );
      for (const a of added) {
        let subj = bySubject.get(a.subjectKey);
        if (!subj) {
          subj = { key: a.subjectKey, name: a.subjectName, engines: new Map() };
          bySubject.set(a.subjectKey, subj);
        }
        subj.engines.set(a.engine, a.agg);
      }
      for (const [k, d] of lastSeenAt) lastSeenBySubject.set(k, d);
    }
    const rows = [...bySubject.values()]
      .map((s) => ({
        key: s.key,
        name: s.name,
        totalMentions: [...s.engines.values()].reduce((a, b) => a + b.mentions, 0),
        /** 主体最近一次出现时间(仅回填主体非 null;展示层标"N 天前") */
        lastSeenAt: lastSeenBySubject.has(s.key) ? lastSeenBySubject.get(s.key)!.toISOString() : null,
        engines: Object.fromEntries(
          [...s.engines.entries()].map(([engine, v]) => [
            engine,
            {
              mentionRate: v.runs > 0 ? Math.round((v.mentions / v.runs) * 1000) / 1000 : null,
              top3Rate: v.runs > 0 ? Math.round((v.top3 / v.runs) * 1000) / 1000 : null,
            },
          ]),
        ),
      }))
      .sort((a, b) => b.totalMentions - a.totalMentions)
      .slice(0, topN);
    const engines = [...new Set(rows.flatMap((r) => Object.keys(r.engines)))].sort();
    return { rows, engines };
  }

  /** 分引擎三率(docs/02 §1.1.1):有效口径(窗口 ∪ 最近有效回填),与矩阵/指标卡同源。 */
  async engineRates(
    brandId: number,
    since: Date,
    precomputed?: Array<{ engine: string; mentioned: boolean; rank: number | null }>,
  ): Promise<Array<{ engine: string; mentionRate: number | null; top3Rate: number | null; top1Rate: number | null; denominatorNote: string }>> {
    const facts = precomputed ?? (await this.effectiveSelfFacts(brandId, since)).effective;
    const byEngine = new Map<string, { valid: number; mentioned: number; top3: number; top1: number }>();
    for (const f of facts) {
      const e = byEngine.get(f.engine) ?? { valid: 0, mentioned: 0, top3: 0, top1: 0 };
      e.valid += 1;
      if (f.mentioned) {
        e.mentioned += 1;
        if (f.rank !== null && f.rank <= 3) e.top3 += 1;
        if (f.rank === 1) e.top1 += 1;
      }
      byEngine.set(f.engine, e);
    }
    return [...byEngine.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([engine, v]) => {
        // 无有效样本返回 null 而非 0:"从未采到"≠"0% 命中"(docs/02 §1.1 静默为 0 禁令)
        const rate = (n: number) => (v.valid > 0 ? Math.round((n / v.valid) * 1000) / 1000 : null);
        return {
          engine,
          mentionRate: rate(v.mentioned),
          top3Rate: rate(v.top3),
          top1Rate: rate(v.top1),
          /** 该组三率的分母 = 该引擎全部有效回答(self 主体,含回填),与总览卡(有名次)口径不同 */
          denominatorNote: '该引擎全部有效回答(self 主体,含最近有效回填)',
        };
      });
  }

  /** 竞品透视(docs/01 §3.4):同批查询同口径解析。 */
  async competitors(brandId: number, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    // 本品三率(与 rankings 同口径,有效口径=窗口∪回填):作为对比的"本品"侧
    const selfFacts = (await this.effectiveSelfFacts(brandId, since)).effective;
    const sValid = selfFacts.length;
    const sMentioned = selfFacts.filter((f) => f.mentioned).length;
    const sTop3 = selfFacts.filter((f) => f.mentioned && f.rank !== null && f.rank <= 3).length;
    const sTop1 = selfFacts.filter((f) => f.mentioned && f.rank === 1).length;
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    const selfRates = {
      mention: rate(sMentioned, sValid),
      top3: rate(sTop3, sValid),
      top1: rate(sTop1, sValid),
    };
    const res = await this.db.execute(sql`
      select
        mf.subject_key, mf.subject_name,
        count(distinct (mf.run_id))                            as runs,
        count(*) filter (where mf.mentioned)                   as mentions,
        count(*) filter (where mf.mentioned and mf.rank <= 3)  as top3,
        count(*) filter (where mf.mentioned and mf.rank = 1)   as top1
      from mention_facts mf
      where mf.brand_id = ${brandId} and mf.ran_at >= ${since}
        and mf.subject_kind in ('competitor', 'discovered')
      group by mf.subject_key, mf.subject_name
      order by mentions desc
      limit 50
    `);
    const competitors: Array<{
      key: string;
      name: string;
      mentions: number;
      mentionRate: number | null;
      top3Rate: number | null;
      top1Rate: number | null;
      /** 尾部补齐主体的最近出现时间;窗口主体为 null */
      lastSeenAt: string | null;
    }> = res.rows.map((r) => {
      const row = r as Record<string, string>;
      const runs = Number(row.runs);
      const mentions = Number(row.mentions);
      const top3 = Number(row.top3);
      const top1 = Number(row.top1);
      const rate = (n: number) => (runs > 0 ? Math.round((n / runs) * 1000) / 1000 : null);
      return {
        key: row.subject_key,
        name: row.subject_name,
        mentions,
        mentionRate: rate(mentions),
        top3Rate: rate(top3),
        top1Rate: rate(top1),
        lastSeenAt: null,
      };
    });
    // 尾部补齐:窗口内整个主体未出现的,回填其最近有效 run 里的竞品样本(带 lastSeen)
    const windowSubjects = new Set(competitors.map((c) => c.key));
    const { tail } = await latestOkRuns(this.db, brandId, since);
    if (tail.size > 0) {
      const tailRunIds = [...tail.values()].map((r) => r.runId);
      const tailRes = await this.db
        .select({
          subjectKey: mentionFacts.subjectKey,
          subjectName: mentionFacts.subjectName,
          mentioned: mentionFacts.mentioned,
          rank: mentionFacts.rank,
          runId: mentionFacts.runId,
          ranAt: mentionFacts.ranAt,
        })
        .from(mentionFacts)
        .where(
          and(
            eq(mentionFacts.brandId, brandId),
            inArray(mentionFacts.runId, tailRunIds),
            inArray(mentionFacts.subjectKind, ['competitor', 'discovered']),
          ),
        );
      const bySubject = new Map<string, { name: string; runs: Set<number>; mentions: number; top3: number; top1: number; lastSeen: Date }>();
      for (const f of tailRes) {
        if (windowSubjects.has(f.subjectKey)) continue; // 窗口已有该主体,不回填
        const s = bySubject.get(f.subjectKey) ?? { name: f.subjectName, runs: new Set<number>(), mentions: 0, top3: 0, top1: 0, lastSeen: f.ranAt };
        s.runs.add(f.runId);
        if (f.mentioned) {
          s.mentions += 1;
          if (f.rank !== null && f.rank <= 3) s.top3 += 1;
          if (f.rank === 1) s.top1 += 1;
        }
        if (f.ranAt > s.lastSeen) s.lastSeen = f.ranAt;
        bySubject.set(f.subjectKey, s);
      }
      for (const [key, s] of bySubject) {
        const runs = s.runs.size;
        const rate = (n: number) => (runs > 0 ? Math.round((n / runs) * 1000) / 1000 : null);
        competitors.push({
          key,
          name: s.name,
          mentions: s.mentions,
          mentionRate: rate(s.mentions),
          top3Rate: rate(s.top3),
          top1Rate: rate(s.top1),
          lastSeenAt: s.lastSeen.toISOString(),
        });
      }
    }
    competitors.sort((a, b) => b.mentions - a.mentions);
    // 竞品均值 = 上表各竞品三率的算术平均(仅计有数据的竞品)
    const avgOf = (pick: (c: { mentionRate: number | null; top3Rate: number | null; top1Rate: number | null }) => number | null) => {
      const vals = competitors.map(pick).filter((v): v is number => v != null);
      return vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    };
    const competitorAvg = {
      mention: avgOf((c) => c.mentionRate),
      top3: avgOf((c) => c.top3Rate),
      top1: avgOf((c) => c.top1Rate),
    };
    return { competitors, selfRates, competitorAvg };
  }

    /** 引用源分析(docs/01 §3.5):明细 + 信源平台偏好 + 自有占比。 */
  async citations(brandId: number, days: number, page = 1, pageSize = 20) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    // 尾部补齐:窗口 ∪ 最近一次有效 run 的引用事实(条目自带时间,聚合自然并入)
    const { tail } = await latestOkRuns(this.db, brandId, since);
    const tailRunIds = [...tail.values()].map((r) => r.runId);
    const where =
      tailRunIds.length > 0
        ? and(
            eq(citationFacts.brandId, brandId),
            or(gte(citationFacts.extractedAt, since), inArray(citationFacts.runId, tailRunIds)),
          )
        : and(eq(citationFacts.brandId, brandId), gte(citationFacts.extractedAt, since));
    const rows = await this.db
      .select()
      .from(citationFacts)
      .where(where)
      // 有标题的行排前,未取标题的长尾沉底(避免整屏"未取到标题"占据第 1 页——
      // 未取行按时间聚堆,倒序时会连片置顶,观感远差于实际覆盖率)
      .orderBy(sql`(title is null or title = '') asc`, desc(citationFacts.extractedAt))
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    // 引擎×类别 与 引擎×域名 两次聚合同源:总量/自有/权威占比与分引擎偏好一起算出
    // 按 (engine, domain, 存储类别) 分组后,JS 侧对 unknown 域名实时归类合并——
    // 字典补条目后,历史 unknown 行无需迁移即可正确归桶
    const byEngineCategory = await this.db
      .select({
        engine: citationFacts.engine,
        domain: citationFacts.domain,
        category: citationFacts.platformCategory,
        n: sql<number>`count(*)::int`,
        owned: sql<number>`count(*) filter (where ${citationFacts.isOwned})::int`,
      })
      .from(citationFacts)
      .where(where)
      .groupBy(citationFacts.engine, citationFacts.domain, citationFacts.platformCategory);
    const byEngineDomain = await this.db
      .select({
        engine: citationFacts.engine,
        domain: citationFacts.domain,
        n: sql<number>`count(*)::int`,
      })
      .from(citationFacts)
      .where(where)
      .groupBy(citationFacts.engine, citationFacts.domain);

    let total = 0;
    let ownedTotal = 0;
    let authoritativeTotal = 0;
    interface EngineAgg {
      engine: string;
      total: number;
      authoritative: number;
      categories: Array<{ category: string; hits: number }>;
      domains: Map<string, number>;
    }
    // DB 域名字典优先(LLM 识别产物),根域+子域后缀匹配;未命中退代码默认字典
    const dictRows = await this.db.execute(sql`select domain, platform, category from platform_domain_dict`);
    const dict = new Map(
      ((dictRows as unknown as { rows: Array<{ domain: string; platform: string }> }).rows ?? []).map((r) => [
        r.domain.toLowerCase(),
        r.platform,
      ]),
    );
    const categoryDict = new Map<string, string>(
      ((dictRows as unknown as { rows: Array<{ domain: string; category: string }> }).rows ?? []).map((r) => [
        r.domain.toLowerCase(),
        r.category,
      ]),
    );
    const domainPlatform = new Map<string, string>();
    for (const r of byEngineDomain) {
      const host = r.domain.toLowerCase().replace(/^www\./, '');
      if (dict.has(host)) {
        domainPlatform.set(host, dict.get(host)!);
        continue;
      }
      const suffix = [...dict.keys()].filter((d) => host.endsWith(`.${d}`)).sort((a, b) => b.length - a.length)[0];
      domainPlatform.set(host, suffix ? dict.get(suffix)! : '');
    }

    const engines = new Map<string, EngineAgg>();
    const ensureEngine = (engine: string): EngineAgg => {
      let e = engines.get(engine);
      if (!e) {
        e = { engine, total: 0, authoritative: 0, categories: [], domains: new Map() };
        engines.set(engine, e);
      }
      return e;
    };
    for (const r of byEngineCategory) {
      const dictHost = r.domain.toLowerCase().replace(/^www\./, '');
      let category = r.category;
      if (category === 'unknown') {
        const hit = categoryDict.get(dictHost);
        category = hit ?? classifyDomain(r.domain).category;
      }
      total += r.n;
      ownedTotal += r.owned;
      const e = ensureEngine(r.engine);
      if (isAuthoritativeCategory(category)) {
        authoritativeTotal += r.n;
        e.authoritative += r.n;
      }
      e.total += r.n;
      e.categories.push({ category, hits: r.n });
    }
    for (const r of byEngineDomain) {
      const e = engines.get(r.engine);
      if (e) e.domains.set(r.domain, r.n);
    }

    const pref = await this.db
      .select({
        domain: citationFacts.domain,
        hits: sql<number>`count(*)::int`,
        owned: sql<number>`count(*) filter (where ${citationFacts.isOwned})::int`,
      })
      .from(citationFacts)
      .where(where)
      .groupBy(citationFacts.domain)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    // 域名 → 平台中文名聚合(auto.sina.cn/k.sina.cn/sina.cn 合并为「新浪」):
    // 展示层语义,字典子域匹配在此现算(采集侧不落 platform 名,免迁移)
    const byPlatform = new Map<string, { hits: number; owned: number; domains: string[] }>();
    for (const r of pref) {
      const platform = classifyDomain(r.domain).platform;
      const cur = byPlatform.get(platform) ?? { hits: 0, owned: 0, domains: [] };
      cur.hits += r.hits;
      cur.owned += r.owned;
      cur.domains.push(r.domain);
      byPlatform.set(platform, cur);
    }

    const perEngine = [...engines.values()]
      .map((e) => ({
        engine: e.engine,
        total: e.total,
        authoritativeShare: e.total > 0 ? Math.round((e.authoritative / e.total) * 1000) / 1000 : null,
        categories: e.categories.sort((a, b) => b.hits - a.hits).slice(0, 6),
        topDomains: [...e.domains.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([domain, hits]) => ({
            domain,
            platform: domainPlatform.get(domain.toLowerCase().replace(/^www\./, '')) ?? classifyDomain(domain).platform,
            hits,
          })),
      }))
      .sort((a, b) => b.total - a.total);

    return {
      items: rows.map((r) => ({
        url: r.rawUrl,
        domain: r.domain,
        platform: classifyDomain(r.domain).platform,
        category:
          r.platformCategory === 'unknown'
            ? classifyDomain(r.domain).category
            : r.platformCategory,
        // 读出侧净化:存量脏标题(样板句/裸 URL/mojibake)在此归 null,展示层回退兜底
        title: sanitizeCitationTitle(r.title),
        isOwned: r.isOwned,
        engine: r.engine,
        extractedAt: r.extractedAt,
      })),
      preference: [...byPlatform.entries()]
        .sort((a, b) => b[1].hits - a[1].hits)
        .slice(0, 20)
        .map(([platform, v]) => ({ platform, domain: v.domains[0]!, domains: v.domains, category: classifyDomain(v.domains[0]!).category, hits: v.hits, owned: v.owned })),
      totals: {
        citations: total,
        owned: ownedTotal,
        ownedShare: total > 0 ? Math.round((ownedTotal / total) * 1000) / 1000 : null,
        /** 权威信源引用率(docs/02 §3):门户/官媒/权威机构/官网类引用占总引用比 */
        authoritative: authoritativeTotal,
        authoritativeShare: total > 0 ? Math.round((authoritativeTotal / total) * 1000) / 1000 : null,
      },
      /** 分引擎信源偏好:每引擎类别构成(Top6)+ 高频域名(Top5),实测口径 */
      perEngine,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 口碑证据样本上限:口碑题数 × 引擎数(约 10×5),全量展示而非抽样(docs/01 §3.6)。 */
  private static readonly REPUTATION_SAMPLE_LIMIT = 100;

  /** 口碑(docs/01 §3.6):仅口碑词;空态诚实(docs/research 03 A5 对策)。 */
  async reputation(brandId: number, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    // 尾部补齐:窗口 ∪ 最近一次有效 run 的口碑事实(样本自带 ranAt,展示层可见新鲜度)
    const { tail } = await latestOkRuns(this.db, brandId, since);
    const tailRunIds = [...tail.values()].map((r) => r.runId);
    const rows = await this.db
      .select()
      .from(reputationFacts)
      .where(
        tailRunIds.length > 0
          ? and(eq(reputationFacts.brandId, brandId), or(gte(reputationFacts.ranAt, since), inArray(reputationFacts.runId, tailRunIds)))
          : and(eq(reputationFacts.brandId, brandId), gte(reputationFacts.ranAt, since)),
      )
      .orderBy(desc(reputationFacts.ranAt));

    const pos = rows.filter((r) => r.sentiment === 'pos').length;
    const neu = rows.filter((r) => r.sentiment === 'neu').length;
    const neg = rows.filter((r) => r.sentiment === 'neg').length;
    // 情绪分统一走 @geo/metrics(docs/02 §4 归一化负分制,−100..+100,0=中性):
    // 此前这里另用 (pos-neg)/n*50+50 的 0-100 制,同一品牌同一天实时页与报告/行动规则
    // 两套刻度共用同一阈值 60,结论可能相反。weightedScore 字段保留为同值别名(前端兼容)
    const weightedScore = sentimentScoreOf(pos, neu, neg, rows.length);
    // 小样本门槛(docs/14 §24):N<10 不出结论性得分,页面展示"数据积累中"
    const MIN_REPUTATION_SAMPLE = 10;

    const terms = new Map<string, { term: string; polarity: 'pos' | 'neg'; runs: number; excerpt: string }>();
    for (const r of rows) {
      for (const t of r.impressionTerms) {
        const key = `${t.term}|${t.polarity}`;
        const prev = terms.get(key);
        if (prev) prev.runs += 1;
        else terms.set(key, { term: t.term, polarity: t.polarity, runs: 1, excerpt: t.excerpt });
      }
    }
    const all = [...terms.values()].sort((a, b) => b.runs - a.runs);
    const sentimentScore = rows.length >= MIN_REPUTATION_SAMPLE ? weightedScore : null;

    // 证据样本补充引擎信息(reputation_facts 不落引擎,从 query_runs 关联)
    const sampleRunIds = [...new Set(rows.slice(0, MonitorService.REPUTATION_SAMPLE_LIMIT).map((r) => r.runId))];
    const runEngines = new Map(
      sampleRunIds.length > 0
        ? (
            await this.db
              .select({ id: queryRuns.id, engine: queryRuns.engine })
              .from(queryRuns)
              .where(inArray(queryRuns.id, sampleRunIds))
          ).map((r) => [r.id, r.engine])
        : [],
    );

    return {
      totals: {
        runs: rows.length,
        pos,
        neu,
        neg,
        sentimentScore,
        hasData: rows.length > 0,
        /** 口径透明(docs/14 §23/§24):样本是否达门槛 + 中性占比 */
        minimumMet: rows.length >= MIN_REPUTATION_SAMPLE,
        minimumRequired: MIN_REPUTATION_SAMPLE,
        neutralShare: rows.length > 0 ? neu / rows.length : null,
        weightedScore,
      },
      strengths: all.filter((t) => t.polarity === 'pos').slice(0, 6),
      weaknesses: all.filter((t) => t.polarity === 'neg').slice(0, 6),
      samples: rows.slice(0, MonitorService.REPUTATION_SAMPLE_LIMIT).map((r) => ({
        runId: r.runId,
        sentiment: r.sentiment,
        excerpt: r.excerpt,
        engine: runEngines.get(r.runId) ?? null,
        ranAt: r.ranAt,
      })),
    };
  }

  /** 行动清单(规则引擎,docs/02 §6):输入全部来自指标服务,可复现(规则版本入库)。 */
  async actionList(brandId: number, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.matrix(brandId, since);
    const engAll = await this.engineRates(brandId, since);
    // 行动规则/LLM 事实层只比"有数据"的引擎:零样本引擎的 null 不进均值与文案
    const eng = engAll.filter(
      (e): e is { engine: string; mentionRate: number; top3Rate: number; top1Rate: number; denominatorNote: string } =>
        e.mentionRate != null && e.top3Rate != null && e.top1Rate != null,
    );
    const cite = await this.citations(brandId, days, 1, 500);
    const rep = await this.reputation(brandId, days);
    const ranking = await this.rankings({ brandId, days });

    const platformAgg = new Map<string, { competitor: number; own: number }>();
    for (const c of cite.items) {
      // 未分类平台不进比对:没有可执行的投放含义,还会把"unknown"泄漏进行动项文案
      if (c.category === 'unknown' || c.category === '其他') continue;
      const agg = platformAgg.get(c.category) ?? { competitor: 0, own: 0 };
      if (c.isOwned) agg.own += 1;
      else agg.competitor += 1;
      platformAgg.set(c.category, agg);
    }

    const val = (m: string) => ranking.cards.find((c) => c.metric === m)?.value ?? 0;
    const rules = generateActionList({
      layers: rows.map((r) => ({ questionId: r.questionId, text: r.questionText, layer: r.layer })),
      metrics: ranking.cards.every((c) => c.value !== null)
        ? { mentionRate: val('mentionRate'), top3Rate: val('top3Rate'), top1Rate: val('top1Rate') }
        : null,
      engineStats: eng,
      competitorCitations: [...platformAgg.entries()].map(([platform, v]) => ({
        platform,
        competitorCount: v.competitor,
        ownCount: v.own,
      })),
      sentimentScore: rep.totals.sentimentScore,
      negativeImpressions: rep.weaknesses.map((w) => ({ term: w.term, count: w.runs })),
    });

    // LLM 处方层(docs/09 同款三层模式):规则做检测器(可复现事实),LLM 把事实 + 品牌画像
    // 转成具体行动项;按天缓存(Redis TTL 24h),失败回落规则文案。未命中时先返回规则项并
    // 后台生成,前端提示"AI 行动项生成中"。
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cacheKey = `geo:actions:llm:${brandId}:${day}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const items = JSON.parse(cached) as ActionItem[];
        if (Array.isArray(items) && items.length > 0) {
          return { rulesetVersion: rules.rulesetVersion, items, source: 'ai' as const };
        }
      }
    } catch {
      // 缓存不可用不致命,走规则
    }

    const brand = (
      await this.db
        .select({ name: brands.name, intro: brands.intro, website: brands.website })
        .from(brands)
        .where(eq(brands.id, brandId))
        .limit(1)
    )[0];
    // LLM 上下文:画像 + 检测事实(含问题文本/引擎分布/信源缺口),越具体处方越可执行
    const weakQuestions = rows
      .filter((r) => r.layer === 'L4' || r.layer === 'L3')
      .slice(0, 4)
      .map((r) => r.questionText);
    const citationsByPlatform = [...platformAgg.entries()]
      .sort((a, b) => b[1].competitor - a[1].competitor)
      .slice(0, 6)
      .map(([platform, v]) => ({ platform, 竞对被引: v.competitor, 我方被引: v.own }));
    void this.generateActionsInBackground(brandId, cacheKey, rules.items, {
      name: brand?.name ?? '',
      intro: brand?.intro ?? '',
      facts: {
        检测事实: rules.items.map((i) => ({ priority: i.priority, ruleId: i.ruleId, dataBasis: i.dataBasis, target: i.target })),
        弱势问题文本: weakQuestions,
        引擎三率: eng.map((e) => ({
          引擎: engineLabel(e.engine),
          提及率: Math.round(e.mentionRate * 1000) / 1000,
          Top3率: Math.round(e.top3Rate * 1000) / 1000,
          首推率: Math.round(e.top1Rate * 1000) / 1000,
        })),
        各平台被引对比: citationsByPlatform,
        负面印象: rep.weaknesses.slice(0, 5).map((w) => ({ term: w.term, 出现次数: w.runs })),
        情绪得分: rep.totals.sentimentScore,
        官网域名: brand?.website ?? null,
      },
    });

    return { rulesetVersion: rules.rulesetVersion, items: rules.items, source: 'rules' as const, generating: true };
  }

  /** 后台生成 AI 行动项并写天级缓存;失败只记日志(前端已拿到规则项)。 */
  private async generateActionsInBackground(
    brandId: number,
    cacheKey: string,
    ruleItems: ActionItem[],
    ctx: { name: string; intro: string; facts: unknown },
  ) {
    try {
      const settings = await loadPlatformSettings(this.db);
      const cfg = settings.insightAgent;
      if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) return;
      const system =
        '你是 AI 搜索优化(GEO)增长顾问。只输出一个 JSON 数组,不要多余文字。' +
        '基于给定的规则检测事实与品牌画像,产出 3-5 条具体可执行的行动项。' +
        'schema: [{"priority":"P0|P1|P2","ruleId":"对应检测事实的 ruleId","action":"具体动作:写什么角度的内容、投到哪类平台、强调什么卖点(60字内,禁止空话)","dataBasis":"数据依据(≤40字)","target":"可验证的目标(≤30字)"}]。' +
        'action 必须引用品牌画像里的具体卖点/产品线;平台只能用「各平台被引对比」里出现过的平台类别名,引擎只能用「引擎三率」里出现过的引擎名。' +
        '禁止使用 L1/L2/L3/L4、ruleId 等内部代号,一律用中文描述(如"全线缺席""0 引擎进前3")。';
      const user = JSON.stringify({ 品牌名: ctx.name, 品牌画像: ctx.intro.slice(0, 800), 检测事实与上下文: ctx.facts }, null, 0);
      const raw = await chatCompletion(
        { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
        { system, user, maxTokens: 2500 },
      );
      const m = raw.text.match(/\[[\s\S]*\]/);
      if (!m) return;
      const items = (JSON.parse(m[0]) as ActionItem[]).filter(
        (i) => ['P0', 'P1', 'P2'].includes(i.priority) && typeof i.action === 'string' && i.action.length >= 10,
      );
      if (items.length < 2) return;
      await this.redis.set(cacheKey, JSON.stringify(items.slice(0, 6)), 'EX', 24 * 3600);
    } catch (err) {
      console.error(`[actions] llm 行动项生成失败 brand=${brandId}:`, (err as Error).message.slice(0, 120));
    }
  }

  /** 日结(docs/05 §4):趋势线与报告只读日结层;worker 定时调用。 */
  async rebuildDaily(brandId: number, date: string) {
    const start = new Date(`${date}T00:00:00Z`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const res = await this.db.execute(sql`
      select
        mf.engine,
        count(*) filter (where true)                                as valid,
        count(*) filter (where mf.mentioned)                        as mentioned,
        count(*) filter (where mf.mentioned and mf.rank <= 3)       as top3,
        count(*) filter (where mf.mentioned and mf.rank = 1)        as top1,
        count(*) filter (where mf.mentioned and mf.rank is not null) as ranked,
        avg(mf.rank) filter (where mf.rank is not null)             as avg_rank
      from mention_facts mf
      where mf.brand_id = ${brandId} and mf.ran_at >= ${start} and mf.ran_at < ${end}
        and mf.subject_kind = 'self'
      group by mf.engine
    `);
    for (const r of res.rows) {
      const row = r as Record<string, string>;
      const valid = Number(row.valid);
      const mentioned = Number(row.mentioned);
      const top3 = Number(row.top3);
      const top1 = Number(row.top1);
      const ranked = Number(row.ranked ?? 0);
      const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
      await this.db
        .insert(dailyMetrics)
        .values({
          brandId,
          date: start.toISOString().slice(0, 10),
          engine: row.engine,
          metrics: {
            valid,
            mentioned,
            top3,
            top1,
            ranked,
            mentionRate: rate(mentioned, valid),
            top3Rate: rate(top3, ranked),
            top1Rate: rate(top1, ranked),
            avgRank: row.avg_rank ? Number(Number(row.avg_rank).toFixed(2)) : null,
          },
        })
        .onConflictDoUpdate({
          target: [dailyMetrics.brandId, dailyMetrics.date, dailyMetrics.engine],
          set: { metrics: sql`excluded.metrics` },
        });
    }
  }

  private async inCalibrationWindow(brandId: number): Promise<boolean> {
    const brand = (await this.db.select().from(brands).where(eq(brands.id, brandId)).limit(1))[0];
    if (!brand) return true;
    return Date.now() - brand.createdAt.getTime() < THRESHOLD_CALIBRATION_GRACE_DAYS * 24 * 3600 * 1000;
  }

  private card(
    metric: MetricCard['metric'],
    value: number | null,
    numerator: number | null,
    denominator: number | null,
    ex: { failed: number; quotaBlocked: number },
    asOf: string,
    source: MetricSource,
    denominatorNote?: string,
    backfilled?: number,
  ): MetricCard {
    return {
      metric,
      value,
      numerator,
      denominator,
      excludedFailed: ex.failed,
      excludedQuotaBlocked: ex.quotaBlocked,
      ...(backfilled ? { backfilled } : {}),
      asOf,
      source,
      ...(denominatorNote ? { denominatorNote } : {}),
    };
  }
}

function stage(
  key: FunnelStage['key'],
  label: string,
  numerator: number,
  denominator: number,
  note: string,
): FunnelStage {
  return {
    key,
    label,
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null,
    denominatorNote: note,
  };
}

function layerOf(top3Engines: number, total: number): 'L1' | 'L2' | 'L3' | 'L4' | null {
  if (total < 3) return null;
  if (top3Engines >= total) return 'L1';
  if (top3Engines === 0) return 'L4';
  return top3Engines / total >= 0.6 ? 'L2' : 'L3';
}
