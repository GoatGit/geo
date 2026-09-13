import { Global, Module } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { loadEnv } from '../config/env';

const env = loadEnv();

export const DB_POOL = 'DB_POOL';
export const DB = 'DB';
export const REDIS = 'REDIS';
export const ENV = 'ENV';

@Global()
@Module({
  providers: [
    { provide: ENV, useValue: env },
    {
      provide: DB_POOL,
      useFactory: () => new Pool({ connectionString: env.databaseUrl, max: 10 }),
    },
    {
      provide: DB,
      useFactory: (pool: Pool): NodePgDatabase => drizzle(pool),
      inject: [DB_POOL],
    },
    {
      provide: REDIS,
      // lazyConnect:导入期不建连(生产首条命令触发;单测环境无 Redis 也不崩)
      useValue: new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 }),
    },
  ],
  exports: [ENV, DB_POOL, DB, REDIS],
})
export class InfraModule {}
