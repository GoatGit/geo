import { normalizeText } from './normalize';

/** 情绪得分(docs/02 §4):正面占比 ×100,四舍五入;无有效数据返回 null。 */
export function sentimentScore(positive: number, valid: number): number | null {
  if (valid <= 0) return null;
  return Math.round((positive / valid) * 100);
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
