/**
 * Worker 环境变量安全解析:脏值(非数字/负数/超界)回落默认值而不是产生 NaN
 * 静默破坏调度与并发(生产事故源:env 手误导致 concurrency=NaN → BullMQ 抛错)。
 */
export function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 浮点比例(熔断阈值等),范围 [min, max],脏值回落默认。 */
export function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
