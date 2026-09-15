/**
 * 本地登录调试入口(不进生产镜像):
 *   只启动 LoginManager(登录编排),不跑调度器/采集/报告——
 *   与生产共用 RDS,但不共用 Redis 队列(本地用 DB1 隔离),避免双重派发。
 *
 *   pnpm exec tsx src/dev-login.ts
 * 需要的环境变量(见 apps/worker-web/.env.debug):
 *   DATABASE_URL(RDS 公网)、REDIS_URL(公网 + /1)、BROWSER_MODE=agentbay、AGENTBAY_*
 */
import { createDb, ensurePartitions } from '@geo/db';
import Redis from 'ioredis';
import { LoginManager } from './login-manager';
import { createBrokerFromEnv } from '@geo/browser-session';

async function main() {
  const { pool, db } = createDb(process.env.DATABASE_URL!);
  await ensurePartitions(pool, 2);

  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const loginRedis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

  const manager = new LoginManager(db, redis, createBrokerFromEnv());
  manager.start();

  const shutdown = async () => {
    await manager.stop();
    await Promise.allSettled([redis.quit(), loginRedis.quit(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  console.log('[dev-login] 本地登录调试进程已就绪(Ctrl-C 退出)');
}

main().catch((e) => { console.error(e); process.exit(1); });
