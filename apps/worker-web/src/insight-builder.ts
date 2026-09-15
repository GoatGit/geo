import { eq, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { insightIndustries, industryInsights } from '@geo/db';
import type {
  BarRankBlock,
  FunnelBlock,
  HeatmapBlock,
  InsightBlock,
  InsightCover,
  RadarBlock,
  ScatterBlock,
  TakeawayBlock,
  TrendBlock,
} from '@geo/shared';

/**
 * 行业洞察数据聚合(docs/01 §3.10「运行」):
 * 按行业聚合跨品牌采集事实(mention/citation/reputation/query_runs)→
 * 组装完整数据报告 blocks(格局/排行/漏斗/热力/雷达/趋势/散点/信源/口碑)。
 *
 * 分层:collectIndustryAggregates(SQL,取数)→ composeIndustryInsight(纯函数,组稿)——
 * 口径与品牌报告一致(docs/02):提及率分母=有效回答(ok_with_answer+ok_empty),
 * Top3/首位分母=有效且有名次;failed/quota_blocked 不进分母只作 excluded 呈现。
 */

// ===== 聚合产物(纯函数输入) =====

export interface BrandAgg {
  brandId: number;
  name: string;
  /** 有效回答数(指标分母) */
  valid: number;
  mentioned: number;
  ranked: number;
  top3: number;
  top1: number;
  avgRank: number | null;
  /** 采集面:监控问题数 / 有效回答数 / 失败数 / 配额拦截数 */
  questions: number;
  answers: number;
  failed: number;
  quotaBlocked: number;
}

export interface LandscapeRow {
  name: string;
  kind: 'self' | 'competitor' | 'discovered';
  mentions: number;
  /** 被提及的不同回答数(触达面) */
  runs: number;
}

export interface CitationAgg {
  total: number;
  owned: number;
  ownedShare: number | null;
  top: Array<{ domain: string; platform: string; category: string; hits: number }>;
  categories: Array<{ category: string; hits: number }>;
}

export interface ReputationAgg {
  total: number;
  pos: number;
  neu: number;
  neg: number;
  posTerms: Array<{ term: string; count: number }>;
  negTerms: Array<{ term: string; count: number }>;
}

export interface IndustryAggregates {
  industry: string;
  /** null = 全量历史 */
  windowDays: number | null;
  from: string | null;
  to: string;
  brands: BrandAgg[];
  /** 品牌 × 引擎命中率(0-1) */
  engineHits: Array<{ brandId: number; engine: string; rate: number; valid: number }>;
  funnel: { answers: number; mentioned: number; top3: number; top1: number };
  landscape: LandscapeRow[];
  citations: CitationAgg;
  reputation: ReputationAgg;
  trend: Array<{ date: string; valid: number; rate: number | null }>;
}

export interface ComposedInsight {
  title: string;
  summary: string;
  cover: InsightCover;
  blocks: InsightBlock[];
}

const pctText = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

// ===== 组稿(纯函数,可单测) =====

export function composeIndustryInsight(agg: IndustryAggregates): ComposedInsight {
  const sorted = [...agg.brands].sort(
    (a, b) => rateOf(b.mentioned, b.valid) - rateOf(a.mentioned, a.valid) || b.valid - a.valid,
  );
  const head = sorted[0];
  const last = sorted[sorted.length - 1];
  const blocks: InsightBlock[] = [];

  // ① 格局定调
  if (head) {
    const headRate = rateOf(head.mentioned, head.valid);
    const tailRate = last && last !== head ? rateOf(last.mentioned, last.valid) : null;
    let text = `${head.name} 以 ${pctText(headRate)} 的有效提及率领跑本行业监测品牌。`;
    if (tailRate != null && tailRate < headRate) {
      text = `${head.name} 以 ${pctText(headRate)} 的有效提及率领跑,尾部品牌 ${last!.name} 仅 ${pctText(tailRate)},头部与尾部差距 ${Math.round((headRate - tailRate) * 100)} 个百分点,可见度分化明显。`;
    }
    blocks.push({
      type: 'takeaway',
      title: 'AI 眼中的行业格局',
      text,
      tone: 'brand',
    } satisfies TakeawayBlock);
  }

  // ② 品牌有效提及率排行
  if (agg.brands.length > 0) {
    blocks.push({
      type: 'barRank',
      title: '品牌有效提及率排行',
      note: `提及率 = 提及该品牌的回答数 ÷ 有效回答数${agg.windowDays ? `(近 ${agg.windowDays} 天)` : '(全量历史)'},失败与配额拦截不计入分母`,
      total: 100,
      unit: '%',
      items: sorted.map((b) => ({
        name: b.name,
        value: Math.round(rateOf(b.mentioned, b.valid) * 1000) / 10,
      })),
    } satisfies BarRankBlock);
  }

  // ③ 行业筛选漏斗
  if (agg.funnel.answers > 0) {
    blocks.push({
      type: 'funnel',
      title: '行业 AI 筛选漏斗',
      note: '从有效回答到首位推荐的逐层收口(全行业 self 事实合计)',
      stages: [
        { label: '有效回答', note: 'ok_with_answer + ok_empty', count: agg.funnel.answers },
        { label: '被提及', note: '回答中主动提及任一监测品牌', count: agg.funnel.mentioned },
        { label: '进入 Top3', note: '推荐位次 ≤ 3', count: agg.funnel.top3 },
        { label: '首位推荐', note: '推荐位次 = 1', count: agg.funnel.top1 },
      ],
    } satisfies FunnelBlock);
  }

  // ④ 品牌 × 引擎命中率热力图
  const engines = [...new Set(agg.engineHits.map((e) => e.engine))].sort();
  if (engines.length > 0 && agg.brands.length > 0) {
    const cell = new Map<string, { rate: number; valid: number }>();
    for (const e of agg.engineHits) cell.set(`${e.brandId}:${e.engine}`, { rate: e.rate, valid: e.valid });
    blocks.push({
      type: 'heatmap',
      title: '品牌 × 引擎命中率',
      note: '单元格 = 该引擎回答中提及该品牌的比例;空白 = 该引擎无有效样本',
      columns: engines,
      rows: agg.brands.map((b) => ({
        name: b.name,
        cells: engines.map((e) => {
          const c = cell.get(`${b.brandId}:${e}`);
          return c && c.valid > 0 ? r3(c.rate) : null;
        }),
      })),
    } satisfies HeatmapBlock);
  }

  // ⑤ 行业口碑印象(正/负高频印象词)
  if (agg.reputation.total > 0) {
    const posShare = r3(agg.reputation.pos / agg.reputation.total);
    blocks.push({
      type: 'takeaway',
      title: '口碑与印象',
      text: `口碑词回答 ${agg.reputation.total} 条,正面 ${agg.reputation.pos} / 中性 ${agg.reputation.neu} / 负面 ${agg.reputation.neg}(正面率 ${pctText(posShare)})。` +
        (agg.reputation.posTerms.length > 0
          ? `高频正面印象:${agg.reputation.posTerms.slice(0, 5).map((t) => `${t.term}×${t.count}`).join('、')}。`
          : '') +
        (agg.reputation.negTerms.length > 0
          ? `待攻负面印象:${agg.reputation.negTerms.slice(0, 5).map((t) => `${t.term}×${t.count}`).join('、')}。`
          : ''),
      tone: agg.reputation.negTerms.length > 0 ? 'warn' : 'good',
    } satisfies TakeawayBlock);
  }

  // ⑥ 引用信源格局
  if (agg.citations.total > 0) {
    blocks.push({
      type: 'barRank',
      title: 'AI 引用信源 Top 8',
      note: `行业合计被引 ${agg.citations.total} 次,自有域名占比 ${pctText(agg.citations.ownedShare)} —— 决定内容投放的优先阵地`,
      total: agg.citations.total,
      items: agg.citations.top.map((d) => ({ name: d.domain, value: d.hits })),
    } satisfies BarRankBlock);
  }

  // ⑦ 头部品牌五维形状对比(雷达)
  const radarBrands = sorted
    .filter((b) => b.valid > 0)
    .slice(0, 5)
    .map((b) => {
      const ownedShare = ownedShareOf(agg, b.brandId);
      return {
        name: b.name,
        values: [
          r3(rateOf(b.mentioned, b.valid)) ?? 0,
          r3(rateOf(b.top3, b.ranked)) ?? 0,
          r3(rateOf(b.top1, b.ranked)) ?? 0,
          posShareOf(agg) ?? 0,
          ownedShare ?? 0,
        ],
      };
    });
  if (radarBrands.length >= 2) {
    blocks.push({
      type: 'radar',
      title: '头部品牌五维形状',
      note: '提及率 / Top3 率 / 首位率 / 行业口碑正面率 / 自有信源引用率(归一 0-1,后两项为行业共享值)',
      axes: ['提及率', 'Top3率', '首位率', '口碑正面', '自有引用'],
      series: radarBrands,
    } satisfies RadarBlock);
  }

  // ⑧ 每日提及率趋势
  if (agg.trend.length >= 3) {
    blocks.push({
      type: 'trend',
      title: '行业每日提及率',
      note: '全行业 self 事实按日聚合;断点表示当日无有效样本',
      unit: '%',
      points: agg.trend.map((t) => ({ label: t.date.slice(5), value: t.rate == null ? null : Math.round(t.rate * 1000) / 10 })),
    } satisfies TrendBlock);
  }

  // ⑨ 品牌象限(提及率 × Top3 率)
  if (sorted.length >= 2 && agg.funnel.answers > 0) {
    blocks.push({
      type: 'scatter',
      title: '品牌可见度象限',
      note: '横轴=有效提及率,纵轴=Top3 率,气泡=有效回答量;右上=双强,左下=待补量',
      xLabel: '有效提及率',
      yLabel: 'Top3 率',
      diagonal: true,
      points: sorted.map((b) => ({
        name: b.name,
        x: r3(rateOf(b.mentioned, b.valid)) ?? 0,
        y: r3(rateOf(b.top3, b.ranked)) ?? 0,
        size: b.valid,
        note: `平均名次 ${b.avgRank ?? '—'}`,
      })),
    } satisfies ScatterBlock);
  }

  // ⑩ 行业实体格局(AI 主动提及的头部实体,含未监测品牌)
  if (agg.landscape.length > 0) {
    blocks.push({
      type: 'barRank',
      title: 'AI 提及实体 Top 10',
      note: '按被提及回答数排序,含监测品牌、其配置竞品与 AI 主动发现的未监测实体 —— 反映真实竞争声场',
      total: agg.funnel.answers,
      items: agg.landscape.slice(0, 10).map((l) => ({
        name: l.name,
        value: l.runs,
        group: l.kind === 'self' ? 'highlight' : l.kind === 'competitor' ? 'domestic' : 'intl',
      })),
    } satisfies BarRankBlock);
  }

  const questions = agg.brands.reduce((a, b) => a + b.questions, 0);
  const answers = agg.brands.reduce((a, b) => a + b.answers, 0);
  const cover: InsightCover = {
    headline: head ? `${head.name} · 有效提及率 ${pctText(rateOf(head.mentioned, head.valid))}` : undefined,
    brands: agg.brands.length,
    questions,
    answers,
    testedAt: agg.to.slice(0, 10),
  };

  const summary = head
    ? `对 ${agg.brands.length} 个品牌、${questions} 个监控问题、${answers} 条有效回答的行业聚合分析:` +
      `${head.name} 以有效提及率 ${pctText(rateOf(head.mentioned, head.valid))}、Top3 率 ${pctText(rateOf(head.top3, head.ranked))} 领跑` +
      (agg.citations.total > 0 ? `;AI 引用合计 ${agg.citations.total} 次,自有信源占比 ${pctText(agg.citations.ownedShare)}` : '') +
      '。'
    : `${agg.industry} 行业暂无可聚合的监测数据。`;

  return {
    title: `${agg.industry}行业 AI 可见度洞察`,
    summary,
    cover,
    blocks,
  };
}

const rateOf = (n: number, d: number) => (d > 0 ? n / d : 0);

function ownedShareOf(agg: IndustryAggregates, brandId: number): number | null {
  // 行业级自有引用率为共享值(引用事实不区分品牌主体);留品牌维度接口
  void brandId;
  return agg.citations.ownedShare;
}
function posShareOf(agg: IndustryAggregates): number | null {
  return agg.reputation.total > 0 ? r3(agg.reputation.pos / agg.reputation.total) : null;
}

// ===== 取数(SQL) =====

/** 收集行业聚合输入;windowDays=null 表示全量历史。行业无监测品牌时抛错。 */
export async function collectIndustryAggregates(
  db: Db,
  industry: string,
  windowDays: number | null,
): Promise<IndustryAggregates> {
  const since = windowDays ? new Date(Date.now() - windowDays * 24 * 3600 * 1000) : null;
  const winMf = since != null ? sql` and mf.ran_at >= ${since.toISOString()}` : sql``;
  const winCf = since != null ? sql` and cf.extracted_at >= ${since.toISOString()}` : sql``;
  const winRf = since != null ? sql` and rf.ran_at >= ${since.toISOString()}` : sql``;
  const winQr = since != null ? sql` and r.ran_at >= ${since.toISOString()}` : sql``;

  const brandRows = rowsOf<{ id: string; name: string }>(
    await db.execute(sql`
      select id::bigint as id, name from brands
      where industry = ${industry} and status = 'active'
      order by id
    `),
  );
  if (brandRows.length === 0) throw new Error(`行业「${industry}」下没有监测品牌,无法聚合`);
  const ids = brandRows.map((b) => Number(b.id));
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);

  const perBrand = await db.execute(sql`
    select mf.brand_id::bigint as brand_id,
           count(*)                                                       as valid,
           count(*) filter (where mf.mentioned)                            as mentioned,
           count(*) filter (where mf.mentioned and mf.rank is not null)    as ranked,
           count(*) filter (where mf.mentioned and mf.rank <= 3)           as top3,
           count(*) filter (where mf.mentioned and mf.rank = 1)            as top1,
           avg(mf.rank) filter (where mf.rank is not null)                 as avg_rank
    from mention_facts mf
    where mf.brand_id in (${idList}) and mf.subject_kind = 'self'${winMf}
    group by mf.brand_id
  `);

  const collect = await db.execute(sql`
    select b.id::bigint as brand_id,
      (select count(*) from monitoring_questions q where q.brand_id = b.id and q.status = 'active') as questions,
      (select count(*) from query_runs r where r.brand_id = b.id and r.status in ('ok_with_answer','ok_empty')${winQr}) as answers,
      (select count(*) from query_runs r where r.brand_id = b.id and r.status = 'failed'${winQr}) as failed,
      (select count(*) from query_runs r where r.brand_id = b.id and r.status = 'quota_blocked'${winQr}) as quota_blocked
    from brands b
    where b.id in (${idList})
  `);

  const engineRows = await db.execute(sql`
    select mf.brand_id::bigint as brand_id, mf.engine,
           count(*)                            as valid,
           count(*) filter (where mf.mentioned) as mentioned
    from mention_facts mf
    where mf.brand_id in (${idList}) and mf.subject_kind = 'self'${winMf}
    group by mf.brand_id, mf.engine
  `);

  const landscape = await db.execute(sql`
    select mf.subject_name,
           max(mf.subject_kind)                                   as subject_kind,
           count(*) filter (where mf.mentioned)                   as mentions,
           count(distinct mf.run_id) filter (where mf.mentioned)  as runs
    from mention_facts mf
    where mf.brand_id in (${idList})${winMf}
    group by mf.subject_name
    having count(*) filter (where mf.mentioned) > 0
    order by mentions desc
    limit 10
  `);

  const cites = await db.execute(sql`
    select cf.domain,
           max(cf.platform_category)                    as platform_category,
           count(*)                                     as hits,
           count(*) filter (where cf.is_owned)          as owned_hits
    from citation_facts cf
    where cf.brand_id in (${idList})${winCf}
    group by cf.domain
    order by hits desc
    limit 8
  `);
  const citeTotals = await db.execute(sql`
    select count(*)                          as total,
           count(*) filter (where is_owned)  as owned,
           count(distinct platform_category) as categories
    from citation_facts cf
    where cf.brand_id in (${idList})${winCf}
  `);
  const citeCategories = await db.execute(sql`
    select platform_category, count(*) as hits
    from citation_facts cf
    where cf.brand_id in (${idList})${winCf}
    group by platform_category
    order by hits desc
  `);

  const repRows = await db.execute(sql`
    select rf.sentiment, rf.impression_terms
    from reputation_facts rf
    where rf.brand_id in (${idList})${winRf}
    limit 2000
  `);

  const trendRows = await db.execute(sql`
    select to_char(date_trunc('day', mf.ran_at), 'YYYY-MM-DD') as d,
           count(*)                            as valid,
           count(*) filter (where mf.mentioned) as mentioned
    from mention_facts mf
    where mf.brand_id in (${idList}) and mf.subject_kind = 'self'${winMf}
    group by 1
    order by 1
  `);

  // ===== 行装配 =====
  const collectBy = new Map(
    rowsOf<{ brand_id: string; questions: string; answers: string; failed: string; quota_blocked: string }>(collect).map(
      (r) => [Number(r.brand_id), r],
    ),
  );
  const brands: BrandAgg[] = brandRows.map((b) => {
    const p = rowsOf<{
      brand_id: string;
      valid: string;
      mentioned: string;
      ranked: string;
      top3: string;
      top1: string;
      avg_rank: string | null;
    }>(perBrand).find((r) => Number(r.brand_id) === Number(b.id));
    const c = collectBy.get(Number(b.id));
    return {
      brandId: Number(b.id),
      name: b.name,
      valid: num(p?.valid),
      mentioned: num(p?.mentioned),
      ranked: num(p?.ranked),
      top3: num(p?.top3),
      top1: num(p?.top1),
      avgRank: p?.avg_rank != null ? Math.round(Number(p.avg_rank) * 100) / 100 : null,
      questions: num(c?.questions),
      answers: num(c?.answers),
      failed: num(c?.failed),
      quotaBlocked: num(c?.quota_blocked),
    };
  });

  const engineHits = rowsOf<{ brand_id: string; engine: string; valid: string; mentioned: string }>(engineRows).map(
    (r) => ({
      brandId: Number(r.brand_id),
      engine: r.engine,
      valid: num(r.valid),
      rate: num(r.valid) > 0 ? num(r.mentioned) / num(r.valid) : 0,
    }),
  );

  const funnel = brands.reduce(
    (acc, b) => ({
      answers: acc.answers + b.valid,
      mentioned: acc.mentioned + b.mentioned,
      top3: acc.top3 + b.top3,
      top1: acc.top1 + b.top1,
    }),
    { answers: 0, mentioned: 0, top3: 0, top1: 0 },
  );

  const ct = rowsOf<{ total: string; owned: string; categories: string }>(citeTotals)[0];
  const citations: CitationAgg = {
    total: num(ct?.total),
    owned: num(ct?.owned),
    ownedShare: num(ct?.total) > 0 ? num(ct?.owned) / num(ct?.total) : null,
    top: rowsOf<{ domain: string; platform_category: string; hits: string; owned_hits: string }>(cites).map((r) => ({
      domain: r.domain,
      platform: r.platform_category,
      category: r.platform_category,
      hits: num(r.hits),
    })),
    categories: rowsOf<{ platform_category: string; hits: string }>(citeCategories).map((r) => ({
      category: r.platform_category,
      hits: num(r.hits),
    })),
  };

  const sentiment = { pos: 0, neu: 0, neg: 0 };
  const posTerms = new Map<string, number>();
  const negTerms = new Map<string, number>();
  let repTotal = 0;
  for (const row of rowsOf<{ sentiment: string; impression_terms: Array<{ term: string; polarity: string }> | null }>(
    repRows,
  )) {
    repTotal += 1;
    if (row.sentiment === 'pos') sentiment.pos += 1;
    else if (row.sentiment === 'neu') sentiment.neu += 1;
    else if (row.sentiment === 'neg') sentiment.neg += 1;
    for (const t of row.impression_terms ?? []) {
      const bucket = t.polarity === 'neg' ? negTerms : posTerms;
      bucket.set(t.term, (bucket.get(t.term) ?? 0) + 1);
    }
  }
  const topTerms = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([term, count]) => ({ term, count }));
  const reputation: ReputationAgg = {
    total: repTotal,
    ...sentiment,
    posTerms: topTerms(posTerms),
    negTerms: topTerms(negTerms),
  };

  const trend = rowsOf<{ d: string; valid: string; mentioned: string }>(trendRows).map((r) => ({
    date: r.d,
    valid: num(r.valid),
    rate: num(r.valid) > 0 ? num(r.mentioned) / num(r.valid) : null,
  }));

  return {
    industry,
    windowDays,
    from: since ? since.toISOString() : null,
    to: new Date().toISOString(),
    brands,
    engineHits,
    funnel,
    landscape: rowsOf<{ subject_name: string; subject_kind: string; mentions: string; runs: string }>(landscape).map(
      (r) => ({
        name: r.subject_name,
        kind: (r.subject_kind as LandscapeRow['kind']) ?? 'discovered',
        mentions: num(r.mentions),
        runs: num(r.runs),
      }),
    ),
    citations,
    reputation,
    trend,
  };
}

function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows;
}
const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0;

// ===== 运行编排(队列消费入口) =====

export interface InsightBuildJob {
  insightId: number;
  windowDays: number | null;
}

/**
 * 运行一次行业洞察聚合:置 running → 取数组稿 → 回写内容(覆盖 blocks/cover/summary,
 * 保留 status/featured 等发布态)→ 置 idle;失败置 failed 并记录原因。
 */
export async function runInsightBuild(db: Db, job: InsightBuildJob): Promise<void> {
  const row = (await db.select().from(industryInsights).where(eq(industryInsights.id, job.insightId)).limit(1))[0];
  if (!row) throw new Error(`insight ${job.insightId} 不存在`);
  const industry = (await db.select().from(insightIndustries).where(eq(insightIndustries.id, row.industryId)).limit(1))[0];

  await db
    .update(industryInsights)
    .set({ buildStatus: 'running', buildError: null })
    .where(eq(industryInsights.id, job.insightId));

  try {
    const agg = await collectIndustryAggregates(db, industry?.name ?? '', job.windowDays);
    const composed = composeIndustryInsight(agg);

    // 期数:同行业已有报告数 + 1(每次运行产生新一期)
    const priorCount = await db.execute(sql`
      select count(*)::int as n from industry_insights where industry_id = ${row.industryId}
    `);
    const issueNo = rowsOf<{ n: number }>(priorCount)[0]?.n ?? 1;

    await db
      .update(industryInsights)
      .set({
        title: composed.title,
        summary: composed.summary,
        cover: composed.cover as unknown as Record<string, unknown>,
        blocks: composed.blocks as unknown[],
        issue: `第 ${issueNo} 期`,
        windowDays: job.windowDays,
        buildStatus: 'idle',
        buildError: null,
        builtAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(industryInsights.id, job.insightId));
  } catch (err) {
    await db
      .update(industryInsights)
      .set({ buildStatus: 'failed', buildError: (err as Error).message.slice(0, 500) })
      .where(eq(industryInsights.id, job.insightId));
    throw err;
  }
}
