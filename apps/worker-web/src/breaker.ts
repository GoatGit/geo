import { Redis } from 'ioredis';
import { breakerManualKey, breakerTrippedKey } from '@geo/shared';

/**
 * 引擎熔断器(docs/04 §5):5 分钟失败率 > 阈值(默认 30%)→ 暂停该引擎派发 + 告警位。
 * 计数按分钟桶滑窗存 Redis,多 Worker 实例共享。
 * manual 位来自管理后台的手动暂停(不过期);tripped 位为自动熔断(5 分钟半开重试)。
 */
export class EngineBreaker {
  constructor(
    private readonly redis: Redis,
    private readonly failRateThreshold = Number(process.env.BREAKER_FAIL_RATE ?? 0.3),
    private readonly windowMinutes = 5,
  ) {}

  private bucketKey(engine: string, kind: 'ok' | 'fail', ts = Date.now()): string {
    const minute = Math.floor(ts / 60_000);
    return `geo:breaker:${engine}:${kind}:${minute}`;
  }

  async record(engine: string, ok: boolean): Promise<void> {
    const key = this.bucketKey(engine, ok ? 'ok' : 'fail');
    await this.redis.incr(key);
    await this.redis.expire(key, (this.windowMinutes + 5) * 60);
    await this.refreshTrip(engine);
  }

  async isTripped(engine: string): Promise<boolean> {
    // 手动暂停优先:自动熔断的半开重试不能越过运营的显式停用
    if ((await this.redis.get(breakerManualKey(engine))) === '1') return true;
    return (await this.redis.get(breakerTrippedKey(engine))) === '1';
  }

  async refreshTrip(engine: string): Promise<boolean> {
    const now = Date.now();
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < this.windowMinutes; i++) {
      const t = now - i * 60_000;
      ok += Number((await this.redis.get(this.bucketKey(engine, 'ok', t))) ?? 0);
      fail += Number((await this.redis.get(this.bucketKey(engine, 'fail', t))) ?? 0);
    }
    const total = ok + fail;
    const rate = total > 0 ? fail / total : 0;
    const trippedKey = breakerTrippedKey(engine);
    if (total >= 10 && rate > this.failRateThreshold) {
      await this.redis.set(trippedKey, '1', 'EX', 300); // 5 分钟半开重试
      return true;
    }
    await this.redis.del(trippedKey);
    return false;
  }
}
