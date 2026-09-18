import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  brands,
  citationFacts,
  dailyMetrics,
  mentionFacts,
  monitoringQuestions,
  queryRuns,
  recognitionEntries, reputationFacts,
} from '@geo/db';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  THRESHOLD_CALIBRATION_GRACE_DAYS,
  type EngineId,
  type FunnelStage,
  type MatrixRow,
  type MetricCard,
  type MetricSource,
} from '@geo/shared';
import { evaluateHealth, generateActionList } from '@geo/metrics';
import Redis from 'ioredis';
import { chatCompletion } from '@geo/insight-agent';
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
    const since = new Date(Date.now() - input.days * 24 * 3600 * 1000);
    const engineFilter = input.engine ? sql`and mf.engine = ${input.engine}` : sql``;

    const totals = await this.db.execute(sql`
      select
        count(*) filter (where true)                                        as valid,
        count(*) filter (where mf.mentioned)                                 as mentioned,
        count(*) filter (where mf.mentioned and mf.rank <= 3)                as top3,
        count(*) filter (where mf.mentioned and mf.rank = 1)                 as top1,
        count(*) filter (where mf.mentioned and mf.rank is not null)         as ranked,
        avg(mf.rank) filter (where mf.mentioned and mf.rank is not null)     as avg_rank
      from mention_facts mf
      where mf.brand_id = ${input.brandId}
        and mf.ran_at >= ${since}
        and mf.subject_kind = 'self'
        and mf.question_id in (select id from monitoring_questions where status = 'active')
        ${engineFilter}
    `);
    const t = (totals.rows[0] ?? {}) as Record<string, string | null>;

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
    const valid = Number(t.valid ?? 0);
    const mentioned = Number(t.mentioned ?? 0);
    const top3 = Number(t.top3 ?? 0);
    const top1 = Number(t.top1 ?? 0);
    const ranked = Number(t.ranked ?? 0);
    const rate = (n: number, d: number | null) => (d && d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    const nEx = { failed: Number(ex.failed ?? 0), quotaBlocked: Number(ex.quota_blocked ?? 0) };

    const cards: MetricCard[] = [
      this.card('mentionRate', rate(mentioned, valid), mentioned, valid, nEx, asOf, source),
      this.card('top3Rate', rate(top3, ranked), top3, ranked, nEx, asOf, source),
      this.card('top1Rate', rate(top1, ranked), top1, ranked, nEx, asOf, source),
      {
        metric: 'avgRank',
        value: t.avg_rank ? Math.round(Number(t.avg_rank) * 100) / 100 : null,
        numerator: ranked,
        denominator: ranked,
        excludedFailed: nEx.failed,
        excludedQuotaBlocked: nEx.quotaBlocked,
        asOf,
        source,
      },
    ];

    const matrix = await this.matrix(input.brandId, since);

    // 可见性漏斗:嵌套转化口径(docs/02 §2,2026-09 修订)
    const funnel: FunnelStage[] = [
      stage('mention', '提及', mentioned, valid, '全部有效 QueryRun(ok_with_answer + ok_empty)'),
      stage('top3', '上榜(Top3)', top3, mentioned, '①的分子:被提及的 QueryRun'),
      stage('top1', '首推(位次=1)', top1, top3, '②的分子:进 Top3 的 QueryRun'),
    ];

    const trend = await this.trend(input.brandId, 7); // 迷你趋势固定近 7 天,不受所选周期影响

    const calibrating = await this.inCalibrationWindow(input.brandId);
    const health = evaluateHealth(
      {
        mentionRate: cards[0]!.value,
        top3Rate: cards[1]!.value,
        top1Rate: cards[2]!.value,
        avgRank: cards[3]!.value,
      },
      DEFAULT_HEALTH_THRESHOLDS,
      calibrating,
    );

    return {
      cards,
      funnel,
      matrix,
      engineStats: await this.engineRates(input.brandId, since),
      trend,
      health,
      excluded: nEx,
      period: { days: input.days, since: since.toISOString() },
      asOf,
      source,
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

    const rows: MatrixRow[] = questions.map((q) => {
      const fs = byQuestion.get(q.id) ?? [];
      // 每引擎取窗口内最好位次(同名问题多轮次取更优,趋势用日结层)
      const perEngine = new Map<string, { mentioned: boolean; rank: number | null; runId: number | null }>();
      for (const f of fs) {
        const prev = perEngine.get(f.engine);
        const better =
          !prev ||
          (f.mentioned && !prev.mentioned) ||
          (f.mentioned && f.rank !== null && (prev.rank === null || f.rank < prev.rank)) ||
          // 位次相同取更新一次(回溯入口指向最新证据)
          (f.mentioned === prev.mentioned &&
            ((f.rank ?? null) === (prev.rank ?? null) && f.runId > (prev.runId ?? 0)));
        if (better) perEngine.set(f.engine, { mentioned: f.mentioned, rank: f.rank, runId: f.runId });
      }
      const cells = [...perEngine.entries()].map(([e, v]) => {
        const pb = prevBest.get(`${q.id}|${e}`);
        return {
          engine: e as EngineId,
          surface: 'web' as const,
          status: 'ok_with_answer' as const,
          mentioned: v.mentioned,
          rank: v.rank,
          /** 最佳位次那次采集的 runId(点击单元格回溯 AI 原文快照) */
          runId: v.runId ?? null,
          /** 上一窗口最好位次(环比 ▲▼ 标记;null=上期无数据) */
          prevRank: pb ? pb.rank : null,
          prevMentioned: pb ? pb.mentioned : null,
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
    for (const r of res.rows) {
      const row = r as Record<string, string>;
      let subj = bySubject.get(row.subject_key);
      if (!subj) {
        subj = { key: row.subject_key, name: row.subject_name, engines: new Map() };
        bySubject.set(row.subject_key, subj);
      }
      const prev = subj.engines.get(row.engine) ?? { runs: 0, mentions: 0, top3: 0 };
      prev.runs += Number(row.runs);
      prev.mentions += Number(row.mentions);
      prev.top3 += Number(row.top3);
      subj.engines.set(row.engine, prev);
    }
    const rows = [...bySubject.values()]
      .map((s) => ({
        key: s.key,
        name: s.name,
        totalMentions: [...s.engines.values()].reduce((a, b) => a + b.mentions, 0),
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

  async engineRates(brandId: number, since: Date) {
    const res = await this.db.execute(sql`
      select
        mf.engine,
        count(*)                                              as valid,
        count(*) filter (where mf.mentioned)                  as mentioned,
        count(*) filter (where mf.mentioned and mf.rank <= 3) as top3,
        count(*) filter (where mf.mentioned and mf.rank = 1)  as top1
      from mention_facts mf
      where mf.brand_id = ${brandId} and mf.ran_at >= ${since}
        and mf.subject_kind = 'self'
      group by mf.engine
      order by mf.engine
    `);
    return res.rows.map((r) => {
      const row = r as Record<string, string>;
      const valid = Number(row.valid);
      const mentioned = Number(row.mentioned);
      const top3 = Number(row.top3);
      const top1 = Number(row.top1);
      const rate = (n: number) => (valid > 0 ? Math.round((n / valid) * 1000) / 1000 : 0);
      return { engine: row.engine, mentionRate: rate(mentioned), top3Rate: rate(top3), top1Rate: rate(top1) };
    });
  }

  /** 竞品透视(docs/01 §3.4):同批查询同口径解析。 */
  async competitors(brandId: number, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
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
    return res.rows.map((r) => {
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
      };
    });
  }

  /**
   * 修正品牌名(docs/07 竞品数据质量):变体竞品归并到主条目。
   * mention_facts 的 subject_key/subject_name 原地改写(历史事实随之并账),
   * 源识别条目删除、其名称收编为主条目别名——后续采集直接按主条目匹配。
   */
  async mergeCompetitor(brandId: number, fromKey: string, toKey: string) {
    // toKey 形如 competitor:{id}:反查主条目
    const toId = Number(toKey.split(':')[1]);
    const to = (
      await this.db
        .select()
        .from(recognitionEntries)
        .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.id, toId)))
        .limit(1)
    )[0];
    if (!to) throw new HttpException('目标竞品不存在', HttpStatus.NOT_FOUND);

    // ① 历史事实原地改写(提及随主条目并账)
    await this.db
      .update(mentionFacts)
      .set({ subjectKey: toKey, subjectName: to.name })
      .where(and(eq(mentionFacts.brandId, brandId), eq(mentionFacts.subjectKey, fromKey)));

    // ② 源名称收编为目标别名(后续采集直接按主条目匹配);源条目下线
    const fromId = Number(fromKey.split(':')[1]);
    const from = (
      await this.db
        .select({ id: recognitionEntries.id, name: recognitionEntries.name, aliases: recognitionEntries.aliases })
        .from(recognitionEntries)
        .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.id, fromId)))
        .limit(1)
    )[0];
    if (from) {
      await this.db.delete(recognitionEntries).where(eq(recognitionEntries.id, from.id));
      const aliases = new Set([...(to.aliases ?? []), from.name]);
      await this.db
        .update(recognitionEntries)
        .set({ aliases: [...aliases] })
        .where(eq(recognitionEntries.id, toId));
    }
    return { merged: true, fromKey, toKey };
  }

  /** 引用源分析(docs/01 §3.5):明细 + 信源平台偏好 + 自有占比。 */
  async citations(brandId: number, days: number, page = 1, pageSize = 20) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const where = and(eq(citationFacts.brandId, brandId), gte(citationFacts.extractedAt, since));
    const rows = await this.db
      .select()
      .from(citationFacts)
      .where(where)
      .orderBy(desc(citationFacts.extractedAt))
      .offset((page - 1) * pageSize)
      .limit(pageSize);
    const totalRow = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        ownedN: sql<number>`count(*) filter (where is_owned)::int`,
      })
      .from(citationFacts)
      .where(where);
    const total = totalRow[0]?.n ?? 0;
    const ownedTotal = totalRow[0]?.ownedN ?? 0;

    const pref = await this.db.execute(sql`
      select domain, platform_category, count(*) as hits,
             count(*) filter (where is_owned) as owned
      from citation_facts
      where brand_id = ${brandId} and extracted_at >= ${since}
      group by domain, platform_category
      order by hits desc
      limit 20
    `);

    return {
      items: rows.map((r) => ({
        url: r.rawUrl,
        domain: r.domain,
        platform: r.domain,
        category: r.platformCategory,
        title: r.title,
        isOwned: r.isOwned,
        engine: r.engine,
        extractedAt: r.extractedAt,
      })),
      preference: pref.rows.map((r) => {
        const row = r as Record<string, string>;
        return { domain: row.domain, category: row.platform_category, hits: Number(row.hits), owned: Number(row.owned) };
      }),
      totals: {
        citations: total,
        owned: ownedTotal,
        ownedShare: total > 0 ? Math.round((ownedTotal / total) * 1000) / 1000 : null,
      },
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
    const rows = await this.db
      .select()
      .from(reputationFacts)
      .where(and(eq(reputationFacts.brandId, brandId), gte(reputationFacts.ranAt, since)))
      .orderBy(desc(reputationFacts.ranAt));

    const pos = rows.filter((r) => r.sentiment === 'pos').length;
    const neu = rows.filter((r) => r.sentiment === 'neu').length;
    const neg = rows.filter((r) => r.sentiment === 'neg').length;

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
    const sentimentScore = rows.length > 0 ? Math.round((pos / rows.length) * 100) : null;

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
      totals: { runs: rows.length, pos, neu, neg, sentimentScore, hasData: rows.length > 0 },
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
    const eng = await this.engineRates(brandId, since);
    const cite = await this.citations(brandId, days, 1, 500);
    const rep = await this.reputation(brandId, days);
    const ranking = await this.rankings({ brandId, days });

    const platformAgg = new Map<string, { competitor: number; own: number }>();
    for (const c of cite.items) {
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

    const brand = (await this.db.select({ intro: brands.intro }).from(brands).where(eq(brands.id, brandId)).limit(1))[0];
    void this.generateActionsInBackground(brandId, cacheKey, rules.items, {
      name: brand?.intro ? '' : '',
      intro: brand?.intro ?? '',
      facts: {
        metrics: rules.items.map((i) => ({ priority: i.priority, ruleId: i.ruleId, dataBasis: i.dataBasis })),
        citations: [...platformAgg.entries()].map(([platform, v]) => ({ platform, competitor: v.competitor, own: v.own })),
        negativeImpressions: rep.weaknesses.map((w) => ({ term: w.term, count: w.runs })),
        sentimentScore: rep.totals.sentimentScore,
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
        'action 必须引用品牌画像里的具体卖点/产品线,平台用检测事实里出现的平台类别。';
      const user = JSON.stringify({ 品牌画像: ctx.intro.slice(0, 800), 规则检测事实: ctx.facts }, null, 0);
      const raw = await chatCompletion(
        { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 60_000 },
        { system, user, maxTokens: 900 },
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
  ): MetricCard {
    return {
      metric,
      value,
      numerator,
      denominator,
      excludedFailed: ex.failed,
      excludedQuotaBlocked: ex.quotaBlocked,
      asOf,
      source,
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
