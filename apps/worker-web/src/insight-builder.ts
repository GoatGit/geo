import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { ENGINE_LABELS, INSIGHT_QUESTION_LAYERS, WEB_ENGINES, engineLabel } from '@geo/shared';
import type { Db } from '@geo/db';
import { insightIndustries, industryInsights, loadPlatformSettings } from '@geo/db';
import { classifyDomain } from '@geo/metrics';
import { chatCompletion } from '@geo/insight-agent';
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
  /** 口碑归属(口碑回答按提及归属到品牌):该品牌口碑回答数与正面/负面数 */
  repTotal: number;
  repPos: number;
  repNeg: number;
  /** 官网域名被引次数(自有信源的硬证据) */
  ownedHits: number;
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
  engineHits: Array<{
    brandId: number;
    /** 主体名(SQL 的 subject_name;热力图按名关联——按数字 id 永远 miss,实测热力图曾全空白) */
    subject?: string;
    engine: string;
    rate: number;
    valid: number;
  }>;
  /** 品牌 × 问题层命中率(0012 问题分层;layer=影子问题 group_name) */
  layerHits: Array<{ layer: string; brand: string; rate: number; valid: number }>;
  layerQuestionCounts: Array<{ layer: string; count: number }>;
  funnel: { answers: number; mentioned: number; top3: number; top1: number };
  landscape: LandscapeRow[];
  citations: CitationAgg;
  reputation: ReputationAgg;
  trend: Array<{ date: string; valid: number; rate: number | null }>;
}

/** 单品牌比率可信的最低样本量:低于此值不进入 headline/环比叙述,图表仅展示并标注样本量。 */
export const MIN_SAMPLE = 5;

export interface ComposedInsight {
  title: string;
  summary: string;
  cover: InsightCover;
  blocks: InsightBlock[];
}

const pctText = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

// ===== 组稿(纯函数,可单测) =====

/**
 * @param prev 上期各品牌有效提及率(0-1),取自同行业上一期报告;首期传 undefined
 */
export function composeIndustryInsight(agg: IndustryAggregates, prev?: Map<string, number>): ComposedInsight {
  // 信源条目域名 → 平台中文名聚合(auto.sina.cn/k.sina.cn/sina.cn →「新浪」);
  // 纯函数层做(可单测),SQL 只出原始域名
  const platformTop = (() => {
    const byPlatform = new Map<string, { domain: string; platform: string; category: string; hits: number }>();
    for (const r of agg.citations.top) {
      const cls = classifyDomain(r.domain);
      const cur = byPlatform.get(cls.platform);
      if (cur) cur.hits += r.hits;
      else byPlatform.set(cls.platform, { domain: r.domain, platform: cls.platform, category: r.category || cls.category, hits: r.hits });
    }
    return [...byPlatform.values()].sort((a, b) => b.hits - a.hits).slice(0, 8);
  })();
  const sorted = [...agg.brands].sort(
    (a, b) => rateOf(b.mentioned, b.valid) - rateOf(a.mentioned, a.valid) || b.valid - a.valid,
  );
  // 叙述口径只认样本充足的品牌:小样本 100%/0% 都是噪声
  const narratable = sorted.filter((b) => b.valid >= MIN_SAMPLE);
  const head = narratable[0] ?? sorted[0];
  const last = narratable[narratable.length - 1] ?? sorted[sorted.length - 1];
  const blocks: InsightBlock[] = [];

  // ⓪ 数据说明(报告开篇:窗口与样本边界,读者先知道数字的分量再看结论)
  {
    const thin = sorted.filter((b) => b.valid > 0 && b.valid < MIN_SAMPLE);
    const parts = [
      `数据窗口${agg.windowDays ? `为近 ${agg.windowDays} 天` : '为全量历史'},共 ${agg.funnel.answers} 条有效回答、${agg.brands.length} 个监测品牌。`,
    ];
    if (narratable.length < sorted.length) {
      parts.push(
        thin.length > 0
          ? `其中 ${thin.map((b) => b.name).join('、')} 的有效回答不足 ${MIN_SAMPLE} 条,其比率仅供参考,不参与格局结论。`
          : `部分品牌样本量不足 ${MIN_SAMPLE} 条,其比率仅供参考。`,
      );
    }
    blocks.push({ type: 'takeaway', title: '数据说明', text: parts.join(''), tone: 'brand' } satisfies TakeawayBlock);
  }

  // ① 格局定调(只叙述样本充足的品牌)
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

  // ② 品牌有效提及率排行(带样本量与环比)
  if (agg.brands.length > 0) {
    const headRate = rateOf(head.mentioned, head.valid);
    const tailRate = last && last !== head ? rateOf(last.mentioned, last.valid) : null;
    // 环比叙述:样本充足且上期有值的品牌中,取提升/回落最陡者
    let deltaLine = '';
    if (prev && prev.size > 0) {
      const movers = narratable
        .map((b) => ({ b, d: prev.has(b.name) ? (rateOf(b.mentioned, b.valid) - (prev.get(b.name) ?? 0)) * 100 : null }))
        .filter((m) => m.d != null) as Array<{ b: (typeof narratable)[number]; d: number }>;
      if (movers.length > 0) {
        const up = movers.reduce((a, m) => (m.d > a.d ? m : a));
        const down = movers.reduce((a, m) => (m.d < a.d ? m : a));
        const fmt = (d: number) => `${Math.abs(Math.round(d * 10) / 10)} 个百分点`;
        deltaLine =
          up.d > 0.5
            ? `较上期,${up.b.name} 提升 ${fmt(up.d)}${down.d < -0.5 && down.b.name !== up.b.name ? `,${down.b.name} 回落 ${fmt(down.d)}` : ''}。`
            : down.d < -0.5
              ? `较上期,${down.b.name} 回落 ${fmt(down.d)}。`
              : '较上期,头部格局基本未变。';
      }
    }
    // 0% 长尾折叠:提及率 0 且无有效样本的品牌整列罗列只添噪声(12 家榜单 8 家全 0 的实测)
    const listed = sorted.filter((b) => rateOf(b.mentioned, b.valid) > 0 || b.valid >= MIN_SAMPLE);
    const zeroHidden = sorted.length - listed.length;
    blocks.push({
      type: 'barRank',
      title: '品牌有效提及率排行',
      summary:
        (tailRate != null && tailRate < headRate
          ? `${head.name} 以 ${pctText(headRate)} 领跑,${last!.name} 仅 ${pctText(tailRate)} —— 首尾相差 ${Math.round((headRate - tailRate) * 100)} 个百分点。`
          : head
            ? `${head.name} 以 ${pctText(headRate)} 领跑监测品牌。`
            : '') + deltaLine,
      note: `条目右侧 n = 该品牌有效回答数(样本量),n<${MIN_SAMPLE} 的比率仅供参考${zeroHidden > 0 ? `;另有 ${zeroHidden} 家提及率 0%(无有效提及,未列出)` : ''}`,
      total: 100,
      unit: '%',
      items: listed.map((b) => {
        const v = Math.round(rateOf(b.mentioned, b.valid) * 1000) / 10;
        return {
          name: b.name,
          value: v,
          n: b.valid,
          ...(prev && prev.has(b.name) && b.valid >= MIN_SAMPLE
            ? { delta: Math.round((v - (prev.get(b.name) ?? 0) * 100) * 10) / 10 }
            : {}),
        };
      }),
    } satisfies BarRankBlock);
  }

  // ③ 行业筛选漏斗
  if (agg.funnel.answers > 0) {
    const { answers, mentioned, top3, top1 } = agg.funnel;
    blocks.push({
      type: 'funnel',
      title: '行业 AI 筛选漏斗',
      summary:
        top1 > 0
          ? `平均每 ${Math.max(1, Math.round(answers / top1))} 次有效回答,才有 1 次把监测品牌推上首位。`
          : '本轮尚无回答把监测品牌推上首位推荐。',
      note: '从有效回答到首位推荐的逐层收口(全行业合计)',
      stages: [
        { label: '有效回答', note: '返回了实质内容的回答', count: answers },
        { label: '被提及', note: '回答中主动提到任一监测品牌', count: mentioned },
        { label: '进入 Top3', note: '出现在推荐前三', count: top3 },
        { label: '首位推荐', note: '排在推荐第一位', count: top1 },
      ],
    } satisfies FunnelBlock);
  }

  // ③.1 品牌存活漏斗(品牌口径,对标竞品方法论):收录 N 个品牌,能撑到最后一层的才是头部
  if (agg.brands.length >= 3) {
    const appeared = sorted.filter((b) => b.mentioned > 0);
    const rate20 = sorted.filter((b) => b.valid > 0 && rateOf(b.mentioned, b.valid) >= 0.2);
    const covered3 = sorted.filter((b) => {
      const hit = new Map<string, number>();
      for (const e of agg.engineHits) {
        if (e.valid > 0 && e.rate > 0) {
          const name = agg.brands.find((x) => x.brandId === e.brandId)?.name;
          if (name) hit.set(name, (hit.get(name) ?? 0) + 1);
        }
      }
      return (hit.get(b.name) ?? 0) >= 3;
    });
    const heads = sorted.filter((b) => b.valid > 0 && rateOf(b.mentioned, b.valid) >= 0.5);
    blocks.push({
      type: 'funnel',
      title: '品牌存活漏斗',
      summary: `收录 ${agg.brands.length} 个行业品牌,能撑到最后一层的只有 ${heads.length} 个 —— 那才是真正的 AI 可见度头部。`,
      note: '品牌口径:与上面回答口径的筛选漏斗互为补充',
      stages: [
        { label: '收录品牌', note: '行业品牌清单', count: agg.brands.length },
        { label: '被主动提及', note: '至少出现在一条有效回答里', count: appeared.length },
        { label: '提及率 ≥ 20%', note: '开始具备存在感', count: rate20.length },
        { label: '命中 ≥ 3 个引擎', note: '不依赖单一 AI 平台', count: covered3.length },
        { label: '头部:提及率 ≥ 50%', note: '稳定的 AI 可见度头部', count: heads.length },
      ],
    } satisfies FunnelBlock);
  }

  // ④ 品牌 × 引擎命中率热力图(整列无样本的引擎不显示,避免全空表占版面)
  const engines = [...new Set(agg.engineHits.filter((e) => e.valid > 0).map((e) => e.engine))].sort();
  if (engines.length > 0 && agg.brands.length > 0) {
    const cell = new Map<string, { rate: number; valid: number }>();
    // 关联键 = 主体名(engineRows 的 brand_id 实为 subject_name;按数字 id 会 NaN miss)
    for (const e of agg.engineHits) cell.set(`${e.subject ?? e.brandId}:${e.engine}`, { rate: e.rate, valid: e.valid });
    let best: { brand: string; engine: string; rate: number } | null = null;
    for (const e of agg.engineHits) {
      if (e.valid <= 0) continue;
      if (!best || e.rate > best.rate) {
        const name = agg.brands.find((b) => (e.subject ? b.name === e.subject : b.brandId === e.brandId))?.name;
        if (name) best = { brand: name, engine: e.engine, rate: e.rate };
      }
    }
    // 引擎显示名(slug → 中文);本期无有效样本的引擎要明说(通常是登录态缺失)
    const missing = (WEB_ENGINES as readonly string[]).filter((e) => !engines.includes(e));
    blocks.push({
      type: 'heatmap',
      title: '品牌 × 引擎命中率',
      summary: best ? `${best.brand} 在 ${engineLabel(best.engine)} 的命中率全场最高(${pctText(best.rate)}),各引擎对品牌的偏好差异明显。` : undefined,
      note:
        '空白 = 该引擎对该品牌无有效样本' +
        (missing.length > 0
          ? `;${missing.map((m) => engineLabel(m)).join('/')} 本轮无有效样本(需在账号池完成该引擎登录后重采)`
          : ''),
      columns: engines.map((e) => engineLabel(e)),
      rows: agg.brands.map((b) => ({
        name: b.name,
        cells: engines.map((e) => {
          const c = cell.get(`${b.name}:${e}`) ?? cell.get(`${b.brandId}:${e}`);
          return c && c.valid > 0 ? r3(c.rate) : null;
        }),
      })),
    } satisfies HeatmapBlock);
  }

  // ④.1 品牌 × 问题层热力图(竞品方法论核心:问题语义分层后,按层看存在感)
  const layerOrder = [...new Set(agg.layerHits.map((h) => h.layer))].sort((a, b) => {
    const ia = (INSIGHT_QUESTION_LAYERS as readonly string[]).indexOf(a);
    const ib = (INSIGHT_QUESTION_LAYERS as readonly string[]).indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  if (layerOrder.length >= 2 && agg.brands.length > 0) {
    const cell = new Map<string, { rate: number; valid: number }>();
    for (const h of agg.layerHits) cell.set(`${h.brand}:${h.layer}`, { rate: h.rate, valid: h.valid });
    let best: { brand: string; layer: string; rate: number } | null = null;
    for (const h of agg.layerHits) {
      if (h.valid < MIN_SAMPLE) continue;
      if (!best || h.rate > best.rate) best = { brand: h.brand, layer: h.layer, rate: h.rate };
    }
    const qNote = agg.layerQuestionCounts.length > 0
      ? `各层题量:${agg.layerQuestionCounts.map((l) => `${l.layer} ${l.count} 题`).join(' / ')}`
      : undefined;
    blocks.push({
      type: 'heatmap',
      title: '品牌 × 问题层命中率',
      summary: best
        ? `${best.brand} 在${best.layer}的存在感全场最强(${pctText(best.rate)}),分层暴露了各品牌打法的差异。`
        : undefined,
      note: ['每格 = 该层问题的提及率(命中 ÷ 有效回答);空白 = 无有效样本', qNote].filter(Boolean).join('。'),
      columns: layerOrder,
      rows: agg.brands.map((b) => ({
        name: b.name,
        cells: layerOrder.map((layer) => {
          const c = cell.get(`${b.name}:${layer}`);
          return c && c.valid > 0 ? r3(c.rate) : null;
        }),
      })),
    } satisfies HeatmapBlock);
  }

  // ⑤ 行业口碑印象(正/负高频印象词)
  if (agg.reputation.total > 0) {
    const posShare = r3(agg.reputation.pos / agg.reputation.total);
    const topPos = agg.reputation.posTerms.slice(0, 3);
    const topNeg = agg.reputation.negTerms.slice(0, 3);
    const parts: string[] = [
      `${agg.reputation.total} 条口碑回答里,正面 ${agg.reputation.pos} 条、负面 ${agg.reputation.neg} 条(正面率 ${pctText(posShare)})。`,
    ];
    if (topPos.length > 0) parts.push(`被 AI 复述最多的好评是「${topPos.map((t) => t.term).join('」「')}」。`);
    if (topNeg.length > 0) parts.push(`拖后腿的负面印象集中在「${topNeg.map((t) => t.term).join('」「')}」。`);
    // 品牌归属叙述:样本充足的品牌里找正面率最高/最低者
    const repBrands = sorted
      .map((b) => ({ name: b.name, share: b.repTotal > 0 ? b.repPos / b.repTotal : null, n: b.repTotal }))
      .filter((r) => r.n >= MIN_SAMPLE);
    if (repBrands.length >= 2) {
      const bestB = repBrands.reduce((a, r) => (r.share! >= a.share! ? r : a));
      const worstB = repBrands.reduce((a, r) => (r.share! <= a.share! ? r : a));
      if (bestB.share !== worstB.share) {
        parts.push(
          `品牌间分化明显:${bestB.name} 正面率 ${pctText(bestB.share)} 最高,${worstB.name} 仅 ${pctText(worstB.share)}。`,
        );
      }
    }
    blocks.push({
      type: 'takeaway',
      title: '口碑与印象',
      text: parts.join(''),
      tone: agg.reputation.negTerms.length > 0 ? 'warn' : 'good',
    } satisfies TakeawayBlock);

    // ⑤.1 品牌口碑正面率排行(口碑回答按提及归属到品牌)
    const repRank = repBrands.sort((a, b) => b.share! - a.share!);
    if (repRank.length >= 2) {
      blocks.push({
        type: 'barRank',
        title: '品牌口碑正面率排行',
        summary: repRank[0]!.share! > (repRank[repRank.length - 1]!.share ?? 0)
          ? `正面率差距最大 ${(Math.round((repRank[0]!.share! - repRank[repRank.length - 1]!.share!) * 1000) / 10)} 个百分点,口碑是 AI 推荐倾向的直接输入。`
          : undefined,
        note: '口碑回答按"回答里提到了谁"归属到品牌;n = 该品牌口碑回答数',
        total: 100,
        unit: '%',
        items: repRank.map((r) => ({ name: r.name, value: Math.round(r.share! * 1000) / 10, n: r.n })),
      } satisfies BarRankBlock);
    }
  }

  // ⑥ 引用信源格局
  if (agg.citations.total > 0) {
    const top3 = agg.citations.top.slice(0, 3).reduce((a, c) => a + c.hits, 0);
    const ownedTotal = agg.brands.reduce((a, b) => a + b.ownedHits, 0);
    blocks.push({
      type: 'barRank',
      title: 'AI 引用信源 Top 8',
      summary:
        top3 > 0
          ? `前三大信源吃掉了 ${Math.round((top3 / agg.citations.total) * 100)}% 的被引次数 —— 想被 AI 提及,先进入这些阵地。`
          : undefined,
      note:
        ownedTotal > 0
          ? `行业合计被引 ${agg.citations.total} 次,品牌官网被引 ${ownedTotal} 次(占比 ${pctText(ownedTotal / agg.citations.total)})`
          : `行业合计被引 ${agg.citations.total} 次`,
      total: agg.citations.total,
      items: platformTop.map((d) => ({ name: d.platform || d.domain, value: d.hits })),
    } satisfies BarRankBlock);
  }

  // ⑦ 头部品牌五维形状对比(雷达)
  const radarBrands = sorted
    .filter((b) => b.valid > 0)
    .slice(0, 5)
    .map((b) => ({
      name: b.name,
      values: [
        r3(rateOf(b.mentioned, b.valid)) ?? 0,
        r3(rateOf(b.top3, b.ranked)) ?? 0,
        r3(rateOf(b.top1, b.ranked)) ?? 0,
        b.repTotal > 0 ? r3(b.repPos / b.repTotal) ?? 0 : 0,
        agg.citations.total > 0 ? r3(b.ownedHits / agg.citations.total) ?? 0 : 0,
      ],
    }));
  if (radarBrands.length >= 2) {
    const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const top5 = [...radarBrands].sort((a, b) => avg(b.values) - avg(a.values));
    const laggard = top5[top5.length - 1]!;
    const laggardAxis = ['提及率', 'Top3率', '首位率', '口碑正面', '官网被引'][
      laggard.values.indexOf(Math.min(...laggard.values))
    ];
    blocks.push({
      type: 'radar',
      title: '头部品牌五维形状',
      summary: `${top5[0]!.name} 五维均值全场最高;${laggard.name} 的短板在${laggardAxis ?? '多个维度'}。`,
      note: '提及率 / Top3 率 / 首位率 / 口碑正面率(口碑回答按提及归属) / 官网被引占比(官网域名被引 ÷ 行业总被引),全部为品牌归属真实值',
      axes: ['提及率', 'Top3率', '首位率', '口碑正面', '官网被引'],
      series: radarBrands,
    } satisfies RadarBlock);
  }

  // ⑧ 每日提及率趋势
  if (agg.trend.length >= 3) {
    const valid = agg.trend.filter((t) => t.rate != null);
    const first = valid[0]?.rate ?? null;
    const lastT = valid[valid.length - 1]?.rate ?? null;
    blocks.push({
      type: 'trend',
      title: '行业每日提及率',
      summary:
        first != null && lastT != null
          ? Math.abs(lastT - first) >= 0.005
            ? `行业提及率从 ${pctText(first)} 走到 ${pctText(lastT)},${lastT >= first ? '整体抬升' : '有所回落'}。`
            : `行业提及率整体走平(${pctText(first)} → ${pctText(lastT)}),格局稳定。`
          : undefined,
      note: '全行业按日聚合;断点表示当日无有效样本',
      unit: '%',
      points: agg.trend.map((t) => ({ label: t.date.slice(5), value: t.rate == null ? null : Math.round(t.rate * 1000) / 10 })),
    } satisfies TrendBlock);
  }

  // ⑨ 品牌象限(提及率 × Top3 率);无有效样本(n=0)的品牌不画点,以注记说明
  const plotted = sorted.filter((b) => b.valid > 0);
  const unplotted = sorted.length - plotted.length;
  if (plotted.length >= 2 && agg.funnel.answers > 0) {
    const dual = plotted.filter((b) => rateOf(b.mentioned, b.valid) >= 0.5 && rateOf(b.top3, b.ranked) >= 0.5);
    const weak = plotted.filter((b) => b.valid >= MIN_SAMPLE && rateOf(b.mentioned, b.valid) < 0.3);
    blocks.push({
      type: 'scatter',
      title: '品牌可见度象限',
      summary: dual.length > 0
        ? `${dual.map((b) => b.name).join('、')} 落在「提及+推荐」双强区${weak.length > 0 ? `,${weak.map((b) => b.name).join('、')} 仍在待补量区` : ''}。`
        : '暂无品牌同时跨过提及与推荐双线,格局尚未固化。',
      note: `横轴=有效提及率,纵轴=Top3 率,气泡=有效回答量${unplotted > 0 ? `;另有 ${unplotted} 家本期无有效提及,未画出` : ''}`,
      xLabel: '有效提及率',
      yLabel: 'Top3 率',
      diagonal: true,
      points: plotted.map((b) => ({
        name: b.name,
        x: r3(rateOf(b.mentioned, b.valid)) ?? 0,
        y: r3(rateOf(b.top3, b.ranked)) ?? 0,
        size: b.valid,
        note: b.avgRank != null ? `平均名次 ${b.avgRank}` : undefined,
      })),
    } satisfies ScatterBlock);
  }

  // ⑩ 行业实体格局(AI 主动提及的头部实体,含未监测品牌)
  if (agg.landscape.length > 0) {
    const unmonitored = agg.landscape.filter((l) => l.kind === 'discovered').length;
    blocks.push({
      type: 'barRank',
      title: 'AI 提及实体 Top 10',
      summary:
        unmonitored > 0
          ? `有 ${unmonitored} 个被 AI 频繁提及的实体还不在监测名单里 —— 真实竞争声场比监测范围更大。`
          : undefined,
      note: '按被提及的回答数排序;橙色 = 监测品牌',
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
    // headline 只由样本充足的品牌担纲:小样本 100% 上封面是可信度事故
    headline:
      head && head.valid >= MIN_SAMPLE
        ? `${head.name} · 有效提及率 ${pctText(rateOf(head.mentioned, head.valid))}`
        : answers > 0
          ? `本期 ${answers} 条有效回答`
          : undefined,
    brands: agg.brands.length,
    questions,
    answers,
    testedAt: agg.to.slice(0, 10),
  };

  const summary = head
    ? `对 ${agg.brands.length} 个品牌、${questions} 个监控问题、${answers} 条有效回答的行业聚合分析:` +
      (head.valid >= MIN_SAMPLE
        ? `${head.name} 以有效提及率 ${pctText(rateOf(head.mentioned, head.valid))}、Top3 率 ${pctText(rateOf(head.top3, head.ranked))} 领跑`
        : '头部品牌样本尚少,格局待更多数据确认') +
      (agg.citations.total > 0 && agg.brands.some((b) => b.ownedHits > 0)
        ? `;AI 引用合计 ${agg.citations.total} 次,品牌官网被引 ${agg.brands.reduce((a, b) => a + b.ownedHits, 0)} 次`
        : '') +
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

  // 独立模型(docs/01 IA ⑤):行业品牌来自 insight_brands;采集数据全部挂在
  // 影子品牌(哨兵账号名下 industry 同名)名下,按 mention_facts.subject_name 分组还原各品牌
  const brandRows = rowsOf<{ id: string; name: string; website: string | null }>(
    await db.execute(sql`
      select ib.id::bigint as id, ib.name, ib.website
      from insight_brands ib
      join insight_industries ii on ii.id = ib.industry_id
      where ii.name = ${industry} and ib.active
      order by ib.id
    `),
  );
  if (brandRows.length === 0) throw new Error(`行业「${industry}」未收录行业品牌,请先在向导完成步骤②`);
  const shadow = rowsOf<{ id: string }>(
    await db.execute(sql`
      select b.id::bigint as id from brands b
      join accounts a on a.id = b.account_id
      where b.industry = ${industry} and a.phone = '10000000000'
      limit 1
    `),
  );
  if (shadow.length === 0) throw new Error(`行业「${industry}」还没有采集数据(影子品牌不存在,请先执行「立即采集」)`);
  const shadowId = Number(shadow[0]!.id);

  const perBrand = await db.execute(sql`
    select mf.subject_name::text as brand_id,
           count(*)                                                       as valid,
           count(*) filter (where mf.mentioned)                            as mentioned,
           count(*) filter (where mf.mentioned and mf.rank is not null)    as ranked,
           count(*) filter (where mf.mentioned and mf.rank <= 3)           as top3,
           count(*) filter (where mf.mentioned and mf.rank = 1)            as top1,
           avg(mf.rank) filter (where mf.rank is not null)                 as avg_rank
    from mention_facts mf
    where mf.brand_id = ${shadowId}${winMf}
    group by mf.subject_name
  `);

  const collect = await db.execute(sql`
    select ${shadowId}::bigint as brand_id,
      (select count(*) from monitoring_questions q where q.brand_id = ${shadowId} and q.status = 'active') as questions,
      (select count(*) from query_runs r where r.brand_id = ${shadowId} and r.status in ('ok_with_answer','ok_empty')${winQr}) as answers,
      (select count(*) from query_runs r where r.brand_id = ${shadowId} and r.status = 'failed'${winQr}) as failed,
      (select count(*) from query_runs r where r.brand_id = ${shadowId} and r.status = 'quota_blocked'${winQr}) as quota_blocked
  `);

  const engineRows = await db.execute(sql`
    select mf.subject_name::text as brand_id, mf.engine,
           count(*)                            as valid,
           count(*) filter (where mf.mentioned) as mentioned
    from mention_facts mf
    where mf.brand_id = ${shadowId}${winMf}
    group by mf.subject_name, mf.engine
  `);

  const layerRows = rowsOf<{ layer: string; brand_name: string; valid: number; mentioned: number }>(
    await db.execute(sql`
      select q.group_name as layer, mf.subject_name as brand_name,
             count(*)::int                             as valid,
             count(*) filter (where mf.mentioned)::int as mentioned
      from mention_facts mf
      join monitoring_questions q on q.id = mf.question_id
      where mf.brand_id = ${shadowId} and q.group_name is not null${winMf}
      group by q.group_name, mf.subject_name
    `),
  );
  const layerQuestionCounts = rowsOf<{ layer: string; count: number }>(
    await db.execute(sql`
      select group_name as layer, count(*)::int as count
      from monitoring_questions
      where brand_id = ${shadowId} and group_name is not null and status = 'active'
      group by group_name
    `),
  );

  const landscape = await db.execute(sql`
    select mf.subject_name,
           min(case mf.subject_kind when 'self' then 1 when 'competitor' then 2 else 3 end) as kind_order,
           count(*) filter (where mf.mentioned)                   as mentions,
           count(distinct mf.run_id) filter (where mf.mentioned)  as runs
    from mention_facts mf
    where mf.brand_id = ${shadowId}${winMf}
    group by mf.subject_name
    having count(*) filter (where mf.mentioned) > 0
    order by mentions desc
    limit 10
  `);

  // 信源噪声过滤:电商商品页/搜索页与低质聚合站不是"内容阵地",混进 Top 榜
  // 会稀释报告专业性(world/bk.taobao.com 实测混入)——按域名后缀整段排除
  const citeNoise = /(^|\\.)(taobao|tmall|jd|pinduoduo|yangkeduo|1688|alibaba|amazon|smzdm|csai|fenbi)\\.com$|^(www\\.)?(google|baidu|bing)\\./i;
  const cites = await db.execute(sql`
    select cf.domain,
           max(cf.platform_category)                    as platform_category,
           count(*)                                     as hits,
           count(*) filter (where cf.is_owned)          as owned_hits
    from citation_facts cf
    where cf.brand_id = ${shadowId}${winCf}
    group by cf.domain
    order by hits desc
    limit 30
  `);
  const citeTotals = await db.execute(sql`
    select count(*)                          as total,
           count(*) filter (where is_owned)  as owned,
           count(distinct platform_category) as categories
    from citation_facts cf
    where cf.brand_id = ${shadowId}${winCf}
  `);
  const citeCategories = await db.execute(sql`
    select platform_category, count(*) as hits
    from citation_facts cf
    where cf.brand_id = ${shadowId}${winCf}
    group by platform_category
    order by hits desc
  `);

  // 官网域名 → 行业品牌 的归属表(自有信源硬证据):取 website 的 host,去 www,子域也算命中
  const brandHosts = new Map<string, string>();
  for (const b of brandRows) {
    const host = (b.website ?? '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      ?.toLowerCase();
    if (host) brandHosts.set(host, b.name);
  }
  const ownedHitsByBrand = new Map<string, number>();
  for (const r of rowsOf<{ domain: string; hits: string }>(
    await db.execute(sql`
      select cf.domain, count(*)::int as hits
      from citation_facts cf
      where cf.brand_id = ${shadowId}${winCf}
      group by cf.domain
    `),
  )) {
    const d = r.domain.toLowerCase().replace(/^www\./, '');
    for (const [host, name] of brandHosts) {
      if (d === host || d.endsWith(`.${host}`)) {
        ownedHitsByBrand.set(name, (ownedHitsByBrand.get(name) ?? 0) + num(r.hits));
        break;
      }
    }
  }

  // 口碑回答的品牌归属:一条口碑回答提到谁,正负面就归属给谁(多品牌同题各计一次)
  const repByBrand = new Map<string, { total: number; pos: number; neg: number }>();
  for (const r of rowsOf<{ subject_name: string; sentiment: string; n: string }>(
    await db.execute(sql`
      select mf.subject_name, rf.sentiment, count(*)::int as n
      from reputation_facts rf
      join mention_facts mf on mf.run_id = rf.run_id and mf.mentioned and mf.brand_id = ${shadowId}
      where rf.brand_id = ${shadowId}
        and mf.subject_name in (${sql.join(
          brandRows.map((b) => sql`${b.name}`),
          sql`, `,
        )})${winRf}
      group by mf.subject_name, rf.sentiment
    `),
  )) {
    const cur = repByBrand.get(r.subject_name) ?? { total: 0, pos: 0, neg: 0 };
    cur.total += num(r.n);
    if (r.sentiment === 'pos') cur.pos += num(r.n);
    else if (r.sentiment === 'neg') cur.neg += num(r.n);
    repByBrand.set(r.subject_name, cur);
  }

  const repRows = await db.execute(sql`
    select sentiment, impression_terms
    from (
      select rf.sentiment, rf.impression_terms, rf.ran_at
      from reputation_facts rf
      where rf.brand_id = ${shadowId}${winRf}
      order by rf.ran_at desc
      limit 2000
    ) rf
  `);
  const repTotal = await db.execute(sql`
    select count(*)::int as total
    from reputation_facts rf
    where rf.brand_id = ${shadowId}${winRf}
  `);

  const trendRows = await db.execute(sql`
    select to_char(date_trunc('day', mf.ran_at), 'YYYY-MM-DD') as d,
           count(*)                            as valid,
           count(*) filter (where mf.mentioned) as mentioned
    from mention_facts mf
    where mf.brand_id = ${shadowId}${winMf}
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
    }>(perBrand).find((r) => r.brand_id === b.name);
    const c = collectBy.get(shadowId);
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
      repTotal: repByBrand.get(b.name)?.total ?? 0,
      repPos: repByBrand.get(b.name)?.pos ?? 0,
      repNeg: repByBrand.get(b.name)?.neg ?? 0,
      ownedHits: ownedHitsByBrand.get(b.name) ?? 0,
    };
  });

  const engineHits = rowsOf<{ brand_id: string; engine: string; valid: string; mentioned: string }>(engineRows).map(
    (r) => ({
      brandId: Number(r.brand_id),
      subject: r.brand_id,
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
    top: rowsOf<{ domain: string; platform_category: string; hits: string; owned_hits: string }>(cites)
      .filter((r) => !citeNoise.test(r.domain))
      .slice(0, 30)
      .map((r) => ({
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
  for (const row of rowsOf<{ sentiment: string; impression_terms: Array<{ term: string; polarity: string }> | null }>(
    repRows,
  )) {
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
    total: num(rowsOf<{ total: number }>(repTotal)[0]?.total),
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
    layerHits: layerRows.map((r) => ({
      layer: r.layer,
      brand: r.brand_name,
      valid: num(r.valid),
      rate: num(r.valid) > 0 ? num(r.mentioned) / num(r.valid) : 0,
    })),
    layerQuestionCounts,
    funnel,
    landscape: rowsOf<{ subject_name: string; kind_order: number; mentions: string; runs: string }>(landscape).map(
      (r) => ({
        name: r.subject_name,
        kind: (r.kind_order === 1 ? 'self' : r.kind_order === 2 ? 'competitor' : 'discovered') as LandscapeRow['kind'],
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

/** 从报告 blocks 提取「品牌有效提及率排行」的 name→value(0-1);无此块返回 undefined。 */
function extractRankItems(blocks: InsightBlock[]): Map<string, number> | undefined {
  const rank = blocks.find(
    (b): b is BarRankBlock => b.type === 'barRank' && b.title === '品牌有效提及率排行' && Array.isArray(b.items),
  );
  if (!rank) return undefined;
  const m = new Map<string, number>();
  for (const it of rank.items) {
    if (typeof it.name === 'string' && typeof it.value === 'number') m.set(it.name, it.value / 100);
  }
  return m.size > 0 ? m : undefined;
}

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
    // 上期环比基线:优先同行业其他报告行(多期并存);报告行复用制下,取自身被覆盖前的旧内容
    const prevRow = (
      await db
        .select({ blocks: industryInsights.blocks })
        .from(industryInsights)
        .where(and(eq(industryInsights.industryId, row.industryId), ne(industryInsights.id, job.insightId)))
        .orderBy(desc(industryInsights.builtAt))
        .limit(5)
    )
      .filter((r) => r.blocks != null)
      .map((r) => extractRankItems(r.blocks as InsightBlock[]))
      .find((m) => m != null);
    const prevSelf = row.blocks ? extractRankItems(row.blocks as InsightBlock[]) : undefined;
    const prev = prevRow ?? prevSelf ?? undefined;
    let composed = composeIndustryInsight(agg, prev);
    // LLM 撰稿层:标题/摘要/核心洞察由 GLM 基于聚合事实撰写;失败保留模板稿(降级可复现)
    try {
      composed = await polishWithLlm(db, industry?.name ?? '', job.windowDays, agg, composed);
    } catch (err) {
      console.error(`[insights] LLM 撰稿失败,使用模板稿 insight=${job.insightId}:`, (err as Error).message.slice(0, 120));
    }

    // 期数:同行业已有报告数 + 1(每次运行产生新一期)
    const priorCount = await db.execute(sql`
      select count(*)::int as n from industry_insights
      where industry_id = ${row.industryId} and id <> ${job.insightId}
    `);
    const issueNo = (rowsOf<{ n: number }>(priorCount)[0]?.n ?? 0) + 1;

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

/** 行业事实摘要(供 LLM 撰稿;紧凑 JSON,控制输入规模)。 */
function factsDigest(agg: IndustryAggregates, windowDays: number | null) {
  const sorted = [...agg.brands].sort((a, b) => rateOf(b.mentioned, b.valid) - rateOf(a.mentioned, a.valid));
  return {
    行业: '',
    窗口: windowDays ? `近${windowDays}天` : '全量历史',
    品牌提及率: sorted.map((b) => ({
      品牌: b.name,
      提及率: pctText(rateOf(b.mentioned, b.valid)),
      有效回答: b.valid,
      Top3率: pctText(rateOf(b.top3, b.valid)),
      首推率: pctText(rateOf(b.top1, b.valid)),
    })),
    引用信源Top5: agg.citations.top.slice(0, 5).map((c) => ({ 平台: c.platform, 域名: c.domain, 被引: c.hits })),
    口碑正面: agg.reputation.posTerms.slice(0, 5).map((i) => ({ 词: i.term, 次数: i.count })),
    口碑负面: agg.reputation.negTerms.slice(0, 5).map((i) => ({ 词: i.term, 次数: i.count })),
    趋势: agg.trend.slice(-7).map((t) => t.rate == null ? null : Math.round(t.rate * 100)),
  };
}

/**
 * LLM 撰稿(docs/01 IA ⑤ 精简重构):标题/摘要/核心洞察由 GLM 基于聚合事实生成,
 * 数据块保持确定性聚合产物。thinking 已在客户端关闭(JSON 任务不需要)。
 */
async function polishWithLlm(
  db: Db,
  industryName: string,
  windowDays: number | null,
  agg: IndustryAggregates,
  composed: ComposedInsight,
): Promise<ComposedInsight> {
  const settings = await loadPlatformSettings(db);
  const cfg = settings.insightAgent;
  if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) return composed;

  // 品牌资料库内容一并喂给 LLM(品牌档案、品牌挖掘产物等——提供"为什么"的语境)
  const matRes = await db.execute(sql`
    select bm.title, bm.content from brand_materials bm
    join brands b on b.id = bm.brand_id
    where b.industry = ${industryName} and bm.kind = 'text'
    order by bm.id desc limit 3
  `);
  const materials = rowsOf<{ title: string; content: string }>(matRes).map((r) => ({
    标题: r.title,
    内容: r.content.slice(0, 400),
  }));

  const digest = { ...factsDigest(agg, windowDays), 行业: industryName, 品牌资料库: materials };
  const system =
    '你是行业分析主编,为一份面向行业从业者公开发布的「行业 AI 可见度监测报告」撰稿。只输出一个 JSON 对象。' +
    '报告的主题是「一个行业的 AI 可见度生态」,不是某个品牌的软文:先对行业整体下判断,品牌数据只是论据。' +
    'schema: {' +
    '"title":"报告标题(≤24字,点明行业与 AI 可见度,可有锐评)",' +
    '"summary":"摘要(≤90字,行业层面最有信息量的结论,禁止空话)",' +
    '"takeaways":[{"label":"洞察标签(≤6字,如 信源集中","text":"≤70字:现象+数据+成因,引用具体品牌名与数字")}×3],' +
    '"landscape":"行业格局段(120-180字):先给行业整体判断(AI 对该行业的整体态度、可见度分化程度),再用品牌数据佐证;解释分化成因时要结合品牌资料库里的定位信息",' +
    '"drivers":"信源与成因段(120-180字):AI 引用的信源偏好说明了什么,内容策略应如何调整;口碑情绪如何影响可见度",' +
    '"actions":"行动建议段(100-150字):给行业参与者(尤其落后者)的可执行动作,要具体到平台与内容形态,可带量化目标"}。' +
    '写作要求:每个论断必须带给定事实中的数字;揭示因果而非复述数据;语气像资深行业分析师的笔记,克制、具体、不用感叹号;' +
    '禁止「其一其二」式罗列、禁止「值得注意的是」「综上所述」等 AI 腔;品牌资料库仅作背景语境,主观描述不要照抄。';
  const raw = await chatCompletion(
    { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 90_000 },
    { system, user: JSON.stringify(digest), maxTokens: 2500 },
  );
  const m = raw.text.match(/\{[\s\S]*\}/);
  if (!m) return composed;
  const parsed = JSON.parse(m[0]) as {
    title?: string;
    summary?: string;
    takeaways?: Array<{ label?: string; text?: string } | string>;
    narrative?: string;
    sections?: { landscape?: string; drivers?: string; actions?: string };
  };
  const takeaways = (Array.isArray(parsed.takeaways) ? parsed.takeaways : [])
    .map((t) => (typeof t === 'string' ? { label: '', text: t } : { label: String(t.label ?? '').slice(0, 8), text: String(t.text ?? '') }))
    .filter((t) => t.text.length >= 8)
    .slice(0, 3);
  if (!parsed.title || !parsed.summary || takeaways.length === 0) return composed;

  // 数字自检(防幻觉):LLM 文中的百分比必须能在事实摘要中找到(±1 容差覆盖舍入)。
  // 违例说明模型编造了比率 → 整篇降级模板稿,宁可朴素不可失实。
  // 白名单覆盖报告中合法出现的全部比率族:品牌三率 + 口碑正面率 + 趋势值 + 引用占比 + 0/100 边界
  const legalPct = new Set<number>([0, 100]);
  for (const b of digest.品牌提及率 ?? []) {
    for (const v of [b.提及率, b.Top3率, b.首推率]) {
      const n = parseFloat(String(v ?? ''));
      if (Number.isFinite(n)) legalPct.add(n);
    }
  }
  if (agg.reputation.total > 0) legalPct.add(Math.round((agg.reputation.pos / agg.reputation.total) * 100));
  for (const t of agg.trend) if (t.rate != null) legalPct.add(Math.round(t.rate * 100));
  for (const c of agg.citations.top) {
    if (agg.citations.total > 0) legalPct.add(Math.round((c.hits / agg.citations.total) * 100));
  }
  if (agg.citations.ownedShare != null) legalPct.add(Math.round(agg.citations.ownedShare * 100));
  const texts = [parsed.title, parsed.summary, ...takeaways.map((t) => t.text), parsed.sections?.landscape, parsed.sections?.drivers, parsed.sections?.actions]
    .filter(Boolean)
    .join(' ');
  const pctsInText = [...texts.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => parseFloat(m[1]!));
  const fabricated = pctsInText.filter((p) => ![...legalPct].some((l) => Math.abs(l - p) <= 1));
  if (fabricated.length > 0) {
    console.error(`[insights] LLM 撰稿出现事实外百分比[${fabricated.join(',')}],降级模板稿`);
    return composed;
  }

  const blocks = [...composed.blocks];
  // 洞察条目 → 独立带标签卡片,替换模板「格局」块(数据说明块永远保留,不能当替换目标)
  const idx = blocks.findIndex((b) => b.type === 'takeaway' && b.title === 'AI 眼中的行业格局');
  const insightBlocks: InsightBlock[] = takeaways.map((t) => ({
    type: 'takeaway',
    title: t.label || '核心洞察',
    text: t.text,
    tone: 'brand',
  }));
  if (idx >= 0) blocks.splice(idx, 1, ...insightBlocks);
  else blocks.splice(1, 0, ...insightBlocks); // 兜底:插在「数据说明」之后

  // 撰稿正文 → 三段结构块(格局 / 成因与信源 / 建议),拒绝 500 字文字墙
  // prompt 的三段是顶层键(landscape/drivers/actions);sections 包装形态一并兼容
  const sec = (parsed.sections ?? parsed) as { landscape?: string; drivers?: string; actions?: string };
  const sectionBlocks: InsightBlock[] = [];
  if (sec?.landscape && sec.landscape.length >= 60) {
    sectionBlocks.push({ type: 'takeaway', title: '行业格局', text: sec.landscape.trim(), tone: 'brand' });
  }
  if (sec?.drivers && sec.drivers.length >= 60) {
    sectionBlocks.push({ type: 'takeaway', title: '成因与信源逻辑', text: sec.drivers.trim(), tone: 'brand' });
  }
  if (sec?.actions && sec.actions.length >= 50) {
    sectionBlocks.push({ type: 'takeaway', title: '可执行建议', text: sec.actions.trim(), tone: 'warn' });
  }
  if (sectionBlocks.length > 0) {
    blocks.splice(Math.max(idx, 1) + insightBlocks.length, 0, ...sectionBlocks);
  } else {
    // 兼容旧输出:只有 narrative 时按长度分级呈现,保证综述不缺失
    const narrative = String(parsed.narrative ?? '').trim();
    if (narrative.length >= 180) {
      const paras = narrative.split(/(?<=。”)|(?<=。)(?=[^\d])/).filter((p) => p.trim().length >= 60).slice(0, 3);
      paras.forEach((p, i) =>
        blocks.splice(Math.max(idx, 1) + insightBlocks.length + i, 0, {
          type: 'takeaway',
          title: ['行业格局', '成因与信源逻辑', '可执行建议'][i] ?? '综述',
          text: p.trim(),
          tone: i === 2 ? 'warn' : 'brand',
        }),
      );
    } else if (narrative.length >= 60) {
      // 短综述不拆段,整段保留(此前 <100 字直接丢弃导致综述缺失,线上实测踩过)
      blocks.splice(Math.max(idx, 1) + insightBlocks.length, 0, {
        type: 'takeaway',
        title: '主编综述',
        text: narrative,
        tone: 'brand',
      });
    }
  }
  return {
    title: parsed.title.slice(0, 60),
    summary: parsed.summary.slice(0, 160),
    cover: composed.cover,
    blocks,
  }
}