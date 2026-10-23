import type { Redis } from 'ioredis';
import type { SessionRegistry, SessionRegistryEntry } from '@geo/browser-session';

/** 登记键:agentbay:session:<sessionId> = {createdAt,purpose}(沿用成本排查时约定的键前缀)。 */
const KEY_PREFIX = 'agentbay:session:';
/**
 * 登记本身的最长保留:只需覆盖「实例挂掉 → 下次启动」的间隔。
 * 会话上限最长 45min(LOGIN_TIMEOUT_MS 拉满时),留一天足够,又不会永久堆键。
 */
const REGISTRY_TTL_SEC = 24 * 3600;

function parseEntry(raw: string | null): Partial<SessionRegistryEntry> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRegistryEntry>;
    if (typeof parsed.createdAt !== 'number') return null;
    return {
      createdAt: parsed.createdAt,
      // 只认已知用途:历史/异常值回落采集上限,避免脏数据跳过超龄判定
      purpose: parsed.purpose === 'login' || parsed.purpose === 'collect' ? parsed.purpose : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * AgentBay 会话登记(Redis 实现):
 * worker 进程崩溃/OOM 时 finally 不会执行,远程会话若声明了 ManualRelease 就会一直按小时计费。
 * 登记让下次启动(或周期清扫)能按会话 ID 找回并释放这些孤儿。
 */
export function createRedisSessionRegistry(redis: Redis): SessionRegistry {
  return {
    async track(entry: SessionRegistryEntry): Promise<void> {
      await redis.set(
        `${KEY_PREFIX}${entry.sessionId}`,
        JSON.stringify({ createdAt: entry.createdAt, purpose: entry.purpose ?? 'collect' }),
        'EX',
        REGISTRY_TTL_SEC,
      );
    },

    async forget(sessionId: string): Promise<void> {
      await redis.del(`${KEY_PREFIX}${sessionId}`);
    },

    async listOlderThan(staleBefore: number): Promise<SessionRegistryEntry[]> {
      const out: SessionRegistryEntry[] = [];
      // 用 SCAN 而不是 KEYS:生产 Redis 与队列/配额共享,KEYS 会阻塞整个实例
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 256);
        cursor = next;
        if (keys.length === 0) continue;
        const values = await redis.mget(...keys);
        keys.forEach((key, i) => {
          const entry = parseEntry(values[i] ?? null);
          // 值缺失/损坏按最老处理:宁可多尝试一次释放,也不让登记永久残留
          const stale = entry?.createdAt === undefined || entry.createdAt <= staleBefore;
          if (!stale) return;
          out.push({
            sessionId: key.slice(KEY_PREFIX.length),
            createdAt: entry?.createdAt ?? 0,
            purpose: entry?.purpose,
          });
        });
      } while (cursor !== '0');
      return out;
    },
  };
}
