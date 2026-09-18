import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * 极简 SQL 迁移器:按文件名序执行,事务包裹,记录到 schema_migrations。
 * 不引入 drizzle-kit —— 分区表 DDL 必须手写,迁移始终以 SQL 为权威。
 */
export async function runMigrations(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // 版本号唯一性告警:同号迁移(如 0004_a/0004_b)按文件名字典序隐式定序,
  // 执行顺序依赖字符串比较而非版本语义,历史上已出现两例;重号时大声提示重命名
  const seenVersions = new Map<string, string>();
  for (const file of files) {
    const version = file.match(/^(\d+)/)?.[1] ?? file;
    const prev = seenVersions.get(version);
    if (prev) {
      console.warn(`[migrator] duplicate migration version ${version}: ${prev} & ${file} — execute order is lexicographic, consider renaming`);
    }
    seenVersions.set(version, file);
  }

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
