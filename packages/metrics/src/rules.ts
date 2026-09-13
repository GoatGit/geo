import { RULESET_VERSION, type ActionItem } from '@geo/shared';
import type { QuestionLayer } from './layering';

export interface EngineRateStat {
  engine: string;
  mentionRate: number;
  top3Rate: number;
  top1Rate: number;
}

export interface RulesContext {
  layers: Array<{ questionId: number; text: string; layer: QuestionLayer | null }>;
  /** 指标卡口径的周期整体三率(分母见 docs/02 §2),无数据为 null */
  metrics: { mentionRate: number; top3Rate: number; top1Rate: number } | null;
  engineStats: EngineRateStat[];
  competitorCitations: Array<{ platform: string; competitorCount: number; ownCount: number }>;
  sentimentScore: number | null;
  negativeImpressions: Array<{ term: string; count: number }>;
}

const PRICE_SERVICE_TERMS = ['价格', '服务', '售后', '收费', '贵', '溢价', '成本'];
const ENGINE_DIFF_PCT = 0.15; // docs/02 §6:某引擎三率显著低于均值(差 > 15pct)
const CITATION_MIN = 3; // 防噪声:竞对被引至少 3 次才比对

/**
 * 行动清单(docs/02 §6,确定性规则引擎,替代竞品 AI Agent):
 * 每条含 优先级 + 规则 ID + 动作模板 + 数据依据 + 目标值;规则集版本随结果返回入库。
 */
export function generateActionList(ctx: RulesContext): {
  rulesetVersion: string;
  items: ActionItem[];
} {
  const items: ActionItem[] = [];

  // P0:存在 L4 问题
  const l4 = ctx.layers.filter((q) => q.layer === 'L4');
  if (l4.length > 0) {
    items.push({
      priority: 'P0',
      ruleId: 'R-P0-L4',
      action: `排查引用源覆盖;对 ${l4.length} 个全线缺席问题(如《${l4[0].text}》)补充结构化事实内容`,
      dataBasis: `${l4.length} 个问题 0/${l4.length} 引擎进 Top3`,
      target: '每个 L4 问题至少 1 个引擎进 Top3',
    });
  }

  // P0:首推转化效率(首推率 < 60% 且 Top3 率 ≥ 60%)
  if (ctx.metrics && ctx.metrics.top1Rate < 0.6 && ctx.metrics.top3Rate >= 0.6) {
    items.push({
      priority: 'P0',
      ruleId: 'R-P0-FIRST-POSITION',
      action: '对已上榜问题做内容前置优化(首因段抢占)',
      dataBasis: `首推率 ${pct(ctx.metrics.top1Rate)} < 60%,Top3 率 ${pct(ctx.metrics.top3Rate)} ≥ 60%`,
      target: `首推率提升至 ≥ ${Math.round(ctx.metrics.top3Rate * 100)}%`,
    });
  }

  // P1:某引擎三率显著低于均值(任一率差 > 15pct)
  const engines = ctx.engineStats;
  if (engines.length >= 2) {
    const mean = {
      mentionRate: avg(engines.map((e) => e.mentionRate)),
      top3Rate: avg(engines.map((e) => e.top3Rate)),
      top1Rate: avg(engines.map((e) => e.top1Rate)),
    };
    for (const e of engines) {
      const diffs: string[] = [];
      if (mean.mentionRate - e.mentionRate > ENGINE_DIFF_PCT)
        diffs.push(`提及率 ${pct(e.mentionRate)} vs 均值 ${pct(mean.mentionRate)}`);
      if (mean.top3Rate - e.top3Rate > ENGINE_DIFF_PCT)
        diffs.push(`Top3 率 ${pct(e.top3Rate)} vs 均值 ${pct(mean.top3Rate)}`);
      if (mean.top1Rate - e.top1Rate > ENGINE_DIFF_PCT)
        diffs.push(`首推率 ${pct(e.top1Rate)} vs 均值 ${pct(mean.top1Rate)}`);
      if (diffs.length > 0) {
        items.push({
          priority: 'P1',
          ruleId: 'R-P1-ENGINE-GAP',
          action: `针对引擎「${e.engine}」的取材偏好定向布局(引用缺口地图联动)`,
          dataBasis: diffs.join(';'),
          target: `「${e.engine}」三率对齐均值(差 ≤15pct)`,
        });
      }
    }
  }

  // P1:竞对在某平台类型被引 ≥ 3× 我方
  for (const c of ctx.competitorCitations) {
    if (c.competitorCount >= CITATION_MIN && c.competitorCount >= 3 * c.ownCount) {
      items.push({
        priority: 'P1',
        ruleId: 'R-P1-CITATION-GAP',
        action: `建议在「${c.platform}」类平台补充结构化内容`,
        dataBasis: `该平台竞对被引 ${c.competitorCount} 次 vs 我方 ${c.ownCount} 次(≥3×)`,
        target: `我方在该平台被引 ≥ ${Math.ceil(c.competitorCount / 3)} 次`,
      });
    }
  }

  // P2:情绪得分 < 60
  if (ctx.sentimentScore !== null && ctx.sentimentScore < 60) {
    items.push({
      priority: 'P2',
      ruleId: 'R-P2-SENTIMENT',
      action: '针对 TOP 待攻印象产出事实澄清内容',
      dataBasis: `情绪得分 ${ctx.sentimentScore} < 60`,
      target: '情绪得分 ≥ 60',
    });
  }

  // P2:负面印象含价格/服务类
  const priceService = ctx.negativeImpressions.filter((i) =>
    PRICE_SERVICE_TERMS.some((t) => i.term.includes(t)),
  );
  if (priceService.length > 0) {
    items.push({
      priority: 'P2',
      ruleId: 'R-P2-PRICE-SERVICE',
      action: '官网与服务渠道补价格、售后结构化信息',
      dataBasis: `负面印象词命中价格/服务类:${priceService.map((i) => i.term).join('、')}`,
      target: '该类待攻印象出现回答数下降 30%',
    });
  }

  const order = { P0: 0, P1: 1, P2: 2 } as const;
  items.sort((a, b) => order[a.priority] - order[b.priority] || a.ruleId.localeCompare(b.ruleId));
  return { rulesetVersion: RULESET_VERSION, items };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (v: number) => `${Math.round(v * 100)}%`;
