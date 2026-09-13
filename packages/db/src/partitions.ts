import type { Pool } from 'pg';

const PARTITIONED_TABLES: Array<{ table: string; column: string }> = [
  { table: 'query_runs', column: 'ran_at' },
  { table: 'mention_facts', column: 'ran_at' },
  { table: 'reputation_facts', column: 'ran_at' },
  { table: 'citation_facts', column: 'extracted_at' },
];

/**
 * 生成分区 DDL 语句:当月与未来 N 个月 + DEFAULT 兜底分区。纯函数,可测。
 * 幂等(IF NOT EXISTS);API 与 Worker 启动时各执行一次,生产另配每日定时。
 */
export function partitionStatements(now: Date, monthsAhead = 2): string[] {
  const stmts: string[] = [];

  for (let offset = 0; offset <= monthsAhead; offset++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
    const y = start.getUTCFullYear();
    const m = String(start.getUTCMonth() + 1).padStart(2, '0');
    const from = start.toISOString();
    const to = end.toISOString();

    for (const { table, column } of PARTITIONED_TABLES) {
      stmts.push(
        `CREATE TABLE IF NOT EXISTS ${table}_${y}_${m} PARTITION OF ${table} ` +
          `FOR VALUES FROM ('${from}') TO ('${to}') -- range: ${column}`,
      );
    }
  }

  for (const { table } of PARTITIONED_TABLES) {
    stmts.push(`CREATE TABLE IF NOT EXISTS ${table}_default PARTITION OF ${table} DEFAULT`);
  }
  return stmts;
}

/** 执行分区 DDL,返回新建分区名。 */
export async function ensurePartitions(pool: Pool, monthsAhead = 2): Promise<string[]> {
  const created: string[] = [];
  for (const stmt of partitionStatements(new Date(), monthsAhead)) {
    const res = await pool.query(stmt);
    if (res.command === 'CREATE TABLE') {
      created.push(stmt.match(/CREATE TABLE IF NOT EXISTS (\S+)/)![1]!);
    }
  }
  return created;
}
