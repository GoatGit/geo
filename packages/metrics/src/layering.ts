export type QuestionLayer = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 分层的用户可读文案(前端/报告/行动项统一口径):
 * 内部代号 L1-L4 只存在于数据与 ruleId,任何用户可见文本一律用这里的文字。
 */
export const LAYER_TEXTS: Record<QuestionLayer, string> = {
  L1: '强势',
  L2: '健康',
  L3: '偏弱',
  L4: '全线缺席',
};

/** null(样本不足)之外的分层转文字;null 由调用方按场景给提示。 */
export function layerText(layer: QuestionLayer | null): string | null {
  return layer ? LAYER_TEXTS[layer] : null;
}

/**
 * 问题分层(docs/02 §5):按"进 Top3 的引擎占比"。
 * N<3 不分层(样本不足);L2 阈值 = 60%(5 引擎时即 3-4 个)。
 */
export function classifyLayer(top3Engines: number, totalEngines: number): QuestionLayer | null {
  if (totalEngines < 3) return null;
  if (top3Engines >= totalEngines) return 'L1';
  if (top3Engines === 0) return 'L4';
  const ratio = top3Engines / totalEngines;
  if (ratio >= 0.6) return 'L2';
  return 'L3';
}
