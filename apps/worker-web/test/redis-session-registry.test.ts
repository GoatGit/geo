import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisSessionRegistry } from '../src/redis-session-registry';

/** 只实现登记用到的最小命令面,记录 set 的 TTL 参数。 */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly setCalls: Array<{ key: string; ttl: number }> = [];

  async set(key: string, value: string, _mode: 'EX', ttl: number): Promise<'OK'> {
    this.store.set(key, value);
    this.setCalls.push({ key, ttl });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async scan(_cursor: string, matchToken: 'MATCH', pattern: string): Promise<[string, string[]]> {
    expect(matchToken).toBe('MATCH');
    const prefix = pattern.replace(/\*$/, '');
    return ['0', [...this.store.keys()].filter((k) => k.startsWith(prefix))];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => this.store.get(k) ?? null);
  }
}

const asRedis = (fake: FakeRedis) => fake as unknown as Redis;

describe('Redis 会话登记', () => {
  it('track 写入创建时间/用途并带 24h TTL,forget 删除', async () => {
    const fake = new FakeRedis();
    const registry = createRedisSessionRegistry(asRedis(fake));
    await registry.track({ sessionId: 'sess-1', createdAt: 1_700_000_000_000, purpose: 'login' });

    expect(fake.setCalls).toEqual([{ key: 'agentbay:session:sess-1', ttl: 24 * 3600 }]);
    expect(JSON.parse(fake.store.get('agentbay:session:sess-1')!)).toEqual({
      createdAt: 1_700_000_000_000,
      purpose: 'login',
    });

    await registry.forget('sess-1');
    expect(fake.store.size).toBe(0);
  });

  it('listOlderThan 只返回超龄登记;缺失/损坏值按最老处理', async () => {
    const fake = new FakeRedis();
    const registry = createRedisSessionRegistry(asRedis(fake));
    await registry.track({ sessionId: 'old', createdAt: 1_000, purpose: 'collect' });
    await registry.track({ sessionId: 'new', createdAt: 9_000, purpose: 'login' });
    fake.store.set('agentbay:session:broken', 'not-json');

    const stale = await registry.listOlderThan(5_000);
    expect(stale.map((e) => e.sessionId).sort()).toEqual(['broken', 'old']);
    expect(stale.find((e) => e.sessionId === 'broken')?.createdAt).toBe(0);
    expect(stale.find((e) => e.sessionId === 'new')).toBeUndefined();
  });
});
