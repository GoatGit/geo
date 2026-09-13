import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export function createDb(databaseUrl: string, max = 10) {
  const pool = new Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 30_000 });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createDb>['db'];
