import { Redis } from 'ioredis';
import { breakerManualKey, breakerTrippedKey } from '@geo/shared';
import { envFloat, envInt } from './config';

/** 最小样本数:样本不足不熔断(冷启动/低流量引擎不被单次失败误杀)。 */
export const BREAKER_MIN_SAMPLES = 10;

/**
 * 熔断决策(纯函数,便于单测):5 分钟失败率 > 阈值且样本 ≥ 最小样本数 → trip。
 */
export function computeTrip(
  ok: number,
  fail: number,
  failRateThreshold: number,
  minSamples = BREAKER_MIN_SAMPLES,
): boolean {
  const total = ok + fail;
  if (total < minSamples) return false;
  return fail / total > failRateThreshold;
}

/**
 * 引擎熔断器(docs/04 §5):5 分钟失败率 > 阈值(默认 30%)→ 暂停该引擎派发 + 告警位。
 * 计数按分钟桶滑窗存 Redis,多 Worker 实例共享;窗口读取一次 pipeline 往返。
 * manual 位来自管理后台的手动暂停(不过期);tripped 位为自动熔断(5 分钟半开重试)。
 */
export class EngineBreaker {
  constructor(
    private readonly redis: Redis,
    private readonly failRateThreshold = envFloat('BREAKER_FAIL_RATE', 0.3, 0, 1),
    private readonly windowMinutes = envInt('BREAKER_WINDOW_MINUTES', 5, 1, 60),
  ) {}

  private bucketKey(engine: string, kind: 'ok' | 'fail', ts = Date.now()): string {
    const minute = Math.floor(ts / 60_000);
    return `geo:breaker:${engine}:${kind}:${minute}`;
  }

  async record(engine: string, ok: boolean): Promise<void> {
    const key = this.bucketKey(engine, ok ? 'ok' : 'fail');
    await this.redis.pipeline().incr(key).expire(key, (this.windowMinutes + 5) * 60).exec();
    await this.refreshTrip(engine);
  }

  async isTripped(engine: string): Promise<boolean> {
    // 手动暂停优先:自动熔断的半开重试不能越过运营的显式停用
    const manual = await this.redis.get(breakerManualKey(engine));
    if (manual === '1') return true;
    return (await this.redis.get(breakerTrippedKey(engine))) === '1';
  }

  /** 重算滑窗失败率并同步 trip 位;返回是否处于熔断。 */
  async refreshTrip(engine: string): Promise<boolean> {
    const now = Date.now();
    const pipe = this.redis.pipeline();
    for (let i = 0; i < this.windowMinutes; i++) {
      const t = now - i * 60_000;
      pipe.get(this.bucketKey(engine, 'ok', t));
      pipe.get(this.bucketKey(engine, 'fail', t));
    }
    const results = await pipe.exec();
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < (results?.length ?? 0); i++) {
      const [err, value] = results![i]!;
      if (err) continue;
      const n = Number(value ?? 0);
      if (!Number.isFinite(n)) continue;
      // pipeline 交错 ok/fail:偶数下标为 ok,奇数为 fail
      if (i % 2 === 0) ok += n;
      else fail += n;
    }
    const tripped = computeTrip(ok, fail, this.failRateThreshold, BREAKER_MIN_SAMPLES);
    const trippedKey = breakerTrippedKey(engine);
    if (tripped) {
      await this.redis.set(trippedKey, '1', 'EX', 300); // 5 分钟半开重试
      console.error(`[breaker] engine=${engine} tripped: fail=${fail} ok=${ok} threshold=${this.failRateThreshold}`);
    } else {
      await this.redis.del(trippedKey);
    }
    return tripped;
  }
}
