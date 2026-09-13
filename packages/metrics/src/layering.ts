export type QuestionLayer = 'L1' | 'L2' | 'L3' | 'L4';

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
