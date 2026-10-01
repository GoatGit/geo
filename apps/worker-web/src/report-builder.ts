import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { brands, citationFacts, latestOkRuns, mentionFacts, monitoringQuestions, reputationFacts, type Db } from '@geo/db';
import { classifyLayer, generateActionList, sentimentScore } from '@geo/metrics';

/** 窗口内单条 self 事实的最小投影(纯函数输入,便于单测)。 */
export interface LayerFact {
  questionId: number;
  engine: string;
  mentioned: boolean;
  rank: number | null;
}

export interface QuestionRow {
  id: number;
  text: string;
  type: string;
}

/**
 * 问题分层聚合(docs/02 §5):与控制台排名透视同口径——每引擎取窗口内最好位次,
 * Top3 引擎数 / 参采引擎数 → L1-L4(N<3 不分层)。纯函数便于单测。
 */
export function aggregateQuestionLayers(questions: QuestionRow[], facts: LayerFact[]) {
  return questions.map((q) => {
    const fs = facts.filter((f) => f.questionId === q.id);
    const perEngine = new Map<string, { mentioned: boolean; rank: number | null }>();
    for (const f of fs) {
      const prev = perEngine.get(f.engine);
      const better =
        !prev ||
        (f.mentioned && !prev.mentioned) ||
        (f.mentioned && f.rank !== null && (prev.rank === null || f.rank < prev.rank));
      if (better) perEngine.set(f.engine, { mentioned: f.mentioned, rank: f.rank });
    }
    const cells = [...perEngine.values()];
    const top3 = cells.filter((c) => c.mentioned && c.rank !== null && c.rank <= 3).length;
    return { id: q.id, text: q.text, type: q.type, layer: classifyLayer(top3, cells.length) };
  });
}

/**
 * 报告 payload 组装(docs/01 §3.8 结构):体检总览 → 位次表现 → 竞品/口碑摘要 →
 * 行动清单 → 附录(口径与方法论,docs/02)。
 */
export async function buildReportPayload(
  db: Db,
  brandId: number,
  type: string,
  period: string,
): Promise<Record<string, unknown>> {
  const brand = (await db.select().from(brands).where(eq(brands.id, brandId)).limit(1))[0];
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  // 尾部补齐(docs/02 §1):逐条区块(分层/竞品/引用/口碑)并入"窗口内缺席对"的
  // 最近一次有效 run 数据;概览 totals 与 excluded 保持本期真实采集口径。
  const { tail } = await latestOkRuns(db, brandId, since);
  const tailRunIds = [...tail.values()].map((r) => r.runId);
  const orTail = tailRunIds.length > 0 ? inArray(mentionFacts.runId, tailRunIds) : undefined;

  const totals = await db.execute(sql`
    select
      count(*) filter (where true)                                         as valid,
      count(*) filter (where mf.mentioned)                                 as mentioned,
      count(*) filter (where mf.mentioned and mf.rank <= 3)                as top3,
      count(*) filter (where mf.mentioned and mf.rank = 1)                 as top1,
      count(*) filter (where mf.mentioned and mf.rank is not null)         as ranked,
      avg(mf.rank) filter (where mf.rank is not null)                      as avg_rank
    from mention_facts mf
    where mf.brand_id = ${brandId} and mf.ran_at >= ${since} and mf.subject_kind = 'self'
  `);
  const t = (totals.rows[0] ?? {}) as Record<string, string>;
  const valid = Number(t.valid ?? 0);
  const ranked = Number(t.ranked ?? 0);
  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

  // 采集口径侧的 excluded(docs/02 §1.1)
  const ex = await db.execute(sql`
    select count(*) filter (where status = 'failed')        as failed,
           count(*) filter (where status = 'quota_blocked') as quota_blocked
    from query_runs
    where brand_id = ${brandId} and ran_at >= ${since}
  `);
  const exRow = (ex.rows[0] ?? {}) as Record<string, string>;

  // 问题分层(窗口内 self 事实按问题聚合,引擎维度)
  const perQuestion = await db
    .select({
      id: monitoringQuestions.id,
      text: monitoringQuestions.textExpanded,
      type: monitoringQuestions.type,
    })
    .from(monitoringQuestions)
    .where(eq(monitoringQuestions.brandId, brandId));
  const facts = await db
    .select({
      questionId: mentionFacts.questionId,
      engine: mentionFacts.engine,
      mentioned: mentionFacts.mentioned,
      rank: mentionFacts.rank,
    })
    .from(mentionFacts)
    .where(
      and(
        eq(mentionFacts.brandId, brandId),
        gte(mentionFacts.ranAt, since),
        eq(mentionFacts.subjectKind, 'self'),
      ),
    );
  // 分层尾部补齐:窗口缺席的 问题×引擎 对,并入其最近一次有效 run 的 self 事实(窗口严格优先)
  let effectiveFacts = facts;
  if (tailRunIds.length > 0) {
    const windowPairs = new Set(facts.map((f) => `${f.questionId}|${f.engine}`));
    const tailFacts = await db
      .select({
        questionId: mentionFacts.questionId,
        engine: mentionFacts.engine,
        mentioned: mentionFacts.mentioned,
        rank: mentionFacts.rank,
      })
      .from(mentionFacts)
      .where(
        and(
          eq(mentionFacts.brandId, brandId),
          eq(mentionFacts.subjectKind, 'self'),
          inArray(mentionFacts.runId, tailRunIds),
        ),
      );
    effectiveFacts = [...facts, ...tailFacts.filter((f) => !windowPairs.has(`${f.questionId}|${f.engine}`))];
  }
  const layers = aggregateQuestionLayers(perQuestion, effectiveFacts);

  const rep = await db
    .select()
    .from(reputationFacts)
    .where(
      tailRunIds.length > 0
        ? and(
            eq(reputationFacts.brandId, brandId),
            or(gte(reputationFacts.ranAt, since), inArray(reputationFacts.runId, tailRunIds)),
          )
        : and(eq(reputationFacts.brandId, brandId), gte(reputationFacts.ranAt, since)),
    )
    .limit(200);
  const pos = rep.filter((r) => r.sentiment === 'pos').length;
  const neu = rep.filter((r) => r.sentiment === 'neu').length;
  const neg = rep.filter((r) => r.sentiment === 'neg').length;

  // 竞品榜(前 5,同批查询同口径;窗口 ∪ 尾部补齐)
  const comp = await db
    .select({
      subjectName: mentionFacts.subjectName,
      mentions: sql<number>`count(*) filter (where ${mentionFacts.mentioned})::int`,
      top3: sql<number>`count(*) filter (where ${mentionFacts.mentioned} and ${mentionFacts.rank} <= 3)::int`,
      runs: sql<number>`count(distinct ${mentionFacts.runId})::int`,
    })
    .from(mentionFacts)
    .where(
      and(
        eq(mentionFacts.brandId, brandId),
        orTail ? or(gte(mentionFacts.ranAt, since), orTail) : gte(mentionFacts.ranAt, since),
        inArray(mentionFacts.subjectKind, ['competitor', 'discovered']),
      ),
    )
    .groupBy(mentionFacts.subjectName)
    .orderBy(desc(sql`count(*) filter (where ${mentionFacts.mentioned})`))
    .limit(5);
  const competitors = comp.map((row) => {
    const runs = row.runs;
    const rate = (n: number) => (runs > 0 ? Math.round((n / runs) * 1000) / 1000 : null);
    return { name: row.subjectName, mentions: row.mentions, mentionRate: rate(row.mentions), top3Rate: rate(row.top3) };
  });

  // 引用源概况(自有域名占比 + 高频信源;窗口 ∪ 尾部补齐)
  const cites = await db
    .select({ domain: citationFacts.domain, isOwned: citationFacts.isOwned })
    .from(citationFacts)
    .where(
      tailRunIds.length > 0
        ? and(
            eq(citationFacts.brandId, brandId),
            or(gte(citationFacts.extractedAt, since), inArray(citationFacts.runId, tailRunIds)),
          )
        : and(eq(citationFacts.brandId, brandId), gte(citationFacts.extractedAt, since)),
    );
  const domainHits = new Map<string, number>();
  let owned = 0;
  for (const c of cites) {
    domainHits.set(c.domain, (domainHits.get(c.domain) ?? 0) + 1);
    if (c.isOwned) owned += 1;
  }
  const topDomains = [...domainHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([domain, hits]) => ({ domain, hits }));

  // 行动清单(规则引擎,docs/02 §6)
  const engineRates = await db.execute(sql`
    select mf.engine,
           count(*) as valid,
           count(*) filter (where mf.mentioned) as mentioned,
           count(*) filter (where mf.mentioned and mf.rank <= 3) as top3,
           count(*) filter (where mf.mentioned and mf.rank = 1) as top1
    from mention_facts mf
    where mf.brand_id = ${brandId} and mf.ran_at >= ${since} and mf.subject_kind = 'self'
    group by mf.engine
  `);
  const eStats = engineRates.rows.map((r) => {
    const row = r as Record<string, string>;
    const v = Number(row.valid) || 1;
    return { engine: row.engine, mentionRate: Number(row.mentioned) / v, top3Rate: Number(row.top3) / v, top1Rate: Number(row.top1) / v };
  });
  const negTerms = new Map<string, number>();
  for (const r of rep) {
    for (const term of r.impressionTerms) {
      if (term.polarity === 'neg') negTerms.set(term.term, (negTerms.get(term.term) ?? 0) + 1);
    }
  }
  const { rulesetVersion, items } = generateActionList({
    layers: layers.map((l) => ({ questionId: l.id, text: l.text, layer: l.layer })),
    metrics:
      valid > 0
        ? {
            mentionRate: Number(t.mentioned ?? 0) / valid,
            top3Rate: Number(t.top3 ?? 0) / (ranked || 1),
            top1Rate: Number(t.top1 ?? 0) / (ranked || 1),
          }
        : null,
    engineStats: eStats,
    competitorCitations: [],
    sentimentScore: sentimentScore(pos, neu, neg, rep.length),
    negativeImpressions: [...negTerms.entries()].map(([term, count]) => ({ term, count })),
  });

  return {
    reportType: type,
    period,
    generatedAt: new Date().toISOString(),
    brand: { id: brandId, name: brand?.name, industry: brand?.industry, website: brand?.website },
    overview: {
      valid,
      mentionRate: rate(Number(t.mentioned ?? 0), valid),
      top3Rate: rate(Number(t.top3 ?? 0), ranked),
      top1Rate: rate(Number(t.top1 ?? 0), ranked),
      avgRank: t.avg_rank ? Number(Number(t.avg_rank).toFixed(2)) : null,
      excluded: { failed: Number(exRow.failed ?? 0), quotaBlocked: Number(exRow.quota_blocked ?? 0) },
    },
    questionLayers: layers,
    competitors,
    citations: {
      total: cites.length,
      owned,
      ownedShare: cites.length > 0 ? Math.round((owned / cites.length) * 1000) / 1000 : null,
      top: topDomains,
    },
    reputation: {
      runs: rep.length,
      sentimentScore: sentimentScore(pos, neu, neg, rep.length),
      weaknesses: [...negTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([term, runs]) => ({ term, runs })),
    },
    actions: items,
    appendix: {
      methodology:
        '口径定义见 docs/02:提及率分母=有效 QueryRun(ok_with_answer+ok_empty);Top3/首推率分母=有效且有名次;综合名次=未上榜记 N+1 取中位数。健康阈值方法论=行业 P75 分位,8 周重校。逐条区块(问题分层/竞品/引用/口碑)含尾部补齐:本期窗口内未采集到的问题×引擎沿用其 30 天内最近一次有效结果(总览数字仍为本期真实采集口径)。',
      rulesetVersion,
      snapshotNote: '原始快照按 7 天保留;报告内引用的证据随报告 payload 归档(docs/01 §3.7)。',
    },
  };
}
