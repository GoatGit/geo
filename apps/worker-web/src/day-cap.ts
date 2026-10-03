import type Redis from 'ioredis';

/**
 * 日额度在途账本(P0-B 修复):调度侧只数"已执行"行会让 60s tick 间的在途任务
 * 反复绕过日上限(并发 4、单 ask 2-4min,一上午可成倍超发)。账本口径:
 * 在途 = 当日入队计数 - 当日完结计数;预算扣减 = 已执行(DB) + 在途(Redis)。
 * key 生命周期 2 天;worker 崩溃残留的计数只会让预算偏保守(宁可少采不超发)。
 */
const TTL_SEC = 2 * 24 * 3600;
const key = (kind: 'enq' | 'fin', day: string, engine?: string) => `geo:cap:${day}:${kind}${engine ? `:${engine}` : ''}`;

export function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function incrBy(redis: Redis, k: string, n: number): Promise<void> {
  if (n <= 0) return;
  await redis.pipeline().incrby(k, n).expire(k, TTL_SEC).exec();
}

/** 记一笔入队(scheduler 首发 + processor 延迟重排都算,保持账本对称)。 */
export async function trackEnqueue(redis: Redis, engine: string, n = 1, day = dayStamp()): Promise<void> {
  await Promise.all([incrBy(redis, key('enq', day), n), incrBy(redis, key('enq', day, engine), n)]);
}

/** 记一笔完结(BullMQ completed/failed 终态,含 quota_blocked 收口)。 */
export async function trackFinish(redis: Redis, engine: string, n = 1, day = dayStamp()): Promise<void> {
  await Promise.all([incrBy(redis, key('fin', day), n), incrBy(redis, key('fin', day, engine), n)]);
}

/** 当日在途数(全局与分引擎):enq - fin,负值钳 0(计数漂移只放宽不放超)。 */
export async function inflight(redis: Redis, day = dayStamp()): Promise<{ global: number; byEngine: Map<string, number> }> {
  const engines = new Set<string>();
  const scan = await redis.keys(`geo:cap:${day}:enq:*`).catch(() => [] as string[]);
  for (const k of scan) engines.add(k.split(':').pop()!);
  const fields = [
    key('enq', day),
    key('fin', day),
    ...[...engines].flatMap((e) => [key('enq', day, e), key('fin', day, e)]),
  ];
  const vals = (await redis.mget(...fields).catch(() => fields.map(() => null))) as Array<string | null> | null;
  const n = (i: number) => Number(vals?.[i] ?? 0);
  const byEngine = new Map<string, number>();
  let i = 2;
  for (const e of engines) {
    byEngine.set(e, Math.max(0, n(i) - n(i + 1)));
    i += 2;
  }
  return { global: Math.max(0, n(0) - n(1)), byEngine };
}
