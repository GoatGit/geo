import { normalizeText } from './normalize';

/** 中性权重:归一化计分的中间档(正面 +1 / 中性 +0.5 / 负面 −1)。 */
export const SENTIMENT_NEUTRAL_WEIGHT = 0.5;

/**
 * 情绪得分(docs/02 §4,2026-09-18 修订为归一化负分制):
 * 得分 = round((正面 + 0.5×中性 − 负面) / 有效数 × 100),值域 −100..+100;
 * 负面主动扣分(负分),60 分以下为负面档(与行动规则/健康阈值同源,见 rules.ts)。
 * 无有效数据返回 null。
 */
export function sentimentScore(positive: number, neutral: number, negative: number, valid: number): number | null {
  if (valid <= 0) return null;
  const weighted = positive + SENTIMENT_NEUTRAL_WEIGHT * neutral - negative;
  return Math.round((weighted / valid) * 100);
}

export interface ImpressionInput {
  term: string;
  polarity: 'pos' | 'neg';
  excerpt: string;
}

export interface AggregatedImpression {
  term: string;
  polarity: 'pos' | 'neg';
  /** 词种计数(docs/02 §4:不是出现次数),跨 run 去重 */
  runs: number;
  excerpts: string[];
}

/**
 * 印象词聚合:按词种(归一 + 同义归并表)计数,每词种至少携带 1 条原文摘录
 * (证据链要求 docs/02 §4)。生产环境同义归并表人工维护、随 parserVersion 入库。
 */
export function aggregateImpressions(
  inputs: ImpressionInput[],
  synonymMap: Record<string, string> = {},
): AggregatedImpression[] {
  const map = new Map<string, AggregatedImpression>();
  for (const input of inputs) {
    const canonical = synonymMap[input.term] ?? input.term;
    const key = `${normalizeText(canonical)}|${input.polarity}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { term: canonical, polarity: input.polarity, runs: 0, excerpts: [] };
      map.set(key, agg);
    }
    agg.runs += 1;
    if (agg.excerpts.length < 3 && input.excerpt) agg.excerpts.push(input.excerpt);
  }
  return [...map.values()].sort((a, b) => b.runs - a.runs);
}

/** 优势印象 / 待攻印象各取 TOP6(docs/02 §4)。 */
export function topImpressions(
  inputs: ImpressionInput[],
  synonymMap?: Record<string, string>,
): { strengths: AggregatedImpression[]; weaknesses: AggregatedImpression[] } {
  const all = aggregateImpressions(inputs, synonymMap);
  return {
    strengths: all.filter((i) => i.polarity === 'pos').slice(0, 6),
    weaknesses: all.filter((i) => i.polarity === 'neg').slice(0, 6),
  };
}
