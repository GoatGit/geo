#!/usr/bin/env node
// 清洗 mock 回放数据(生产/环境通用,幂等):
//   node scripts/clean-mock-runs.mjs [品牌名]
// 删除 adapter_version='mock-1' 的 query_runs 及其 mention/citation/reputation 事实,
// 并把受影响轮次的 totals 重算(跑完的轮次重置为进行中,由真实采集重新收口)。
// 可选参数:品牌名 → 只清洗该品牌;缺省清洗全库的 mock-1 数据。
// 凭据取 DATABASE_URL 环境变量(SAE webshell 内已具备;本地用 .env 对应库)。
import { readFileSync } from 'node:fs';
import pg from 'pg';

const brandName = process.argv[2];
const databaseUrl =
  process.env.DATABASE_URL ??
  (() => {
    try {
      const line = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('DATABASE_URL='));
      return line?.slice('DATABASE_URL='.length).trim();
    } catch {
      return undefined;
    }
  })();

if (!databaseUrl) {
  console.error('缺少 DATABASE_URL(环境变量或 ../../.env)');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const brand = brandName
    ? (
        await client.query('select id, name from brands where name = $1', [brandName])
      ).rows[0]
    : undefined;
  if (brandName && !brand) {
    console.error(`品牌不存在: ${brandName}`);
    process.exit(1);
  }

  const params = brand ? [brand.id] : [];
  const runs = (
    await client.query(
      `select id, brand_id, round_id from query_runs
       where adapter_version = 'mock-1' ${brand ? 'and brand_id = $1' : ''}`,
      params,
    )
  ).rows;
  const ids = runs.map((r) => r.id);
  console.log(`mock-1 runs: ${ids.length}${brand ? `(品牌 ${brand.name})` : ''}`);
  if (ids.length === 0) {
    await client.query('ROLLBACK');
    console.log('无可清洗数据');
    process.exit(0);
  }

  for (const table of ['mention_facts', 'citation_facts', 'reputation_facts']) {
    const d = await client.query(`delete from ${table} where run_id = any($1::bigint[])`, [ids]);
    console.log(`  ${table}: -${d.rowCount}`);
  }
  await client.query('delete from query_runs where id = any($1::bigint[])', [ids]);

  // 受影响轮次:重算 totals(剩余 run 数),全部标记进行中 → 真实采集重新收口
  const roundIds = [...new Set(runs.map((r) => r.round_id).filter(Boolean))];
  for (const roundId of roundIds) {
    const c = (
      await client.query(
        `select count(*)::int as total,
                count(*) filter (where status in ('ok_with_answer','ok_empty'))::int as ok,
                count(*) filter (where status = 'failed')::int as failed
         from query_runs where round_id = $1`,
        [roundId],
      )
    ).rows[0];
    await client.query(
      `update collection_rounds
       set totals = jsonb_build_object('total', $2, 'enqueued', $2, 'done', $2, 'ok', $3, 'failed', $4),
           finished_at = null
       where id = $1`,
      [roundId, c.total, c.ok, c.failed],
    );
  }
  console.log(`  轮次重算: ${roundIds.length} 个`);

  await client.query('COMMIT');
  console.log('✅ 清洗完成。重新采集:管理后台对对应问题「保存」触发首轮,或等待下一调度周期。');
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('清洗失败(已回滚):', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
