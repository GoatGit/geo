#!/usr/bin/env node
/**
 * 影子评测(docs/09 §7、§11 M2→M3 门禁):
 * 扫描 query_runs.meta->'insightShadow',输出规则 vs LLM 双侧一致率与分歧明细。
 * 用法:DATABASE_URL=... node eval-insight-shadow.mjs [task=mention|reputation] [limit=500]
 * 离线运行,只读;结论作为 M2→M3 切流的 golden-set 参考。
 */
import pg from 'pg';

const task = process.argv[2] ?? 'mention';
const limit = Number(process.argv[3] ?? 500);
if (!process.env.DATABASE_URL) {
  console.error('需要 DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const res = await client.query(
  `select id, brand_id, ran_at, meta->'insightShadow' as shadow
   from query_runs
   where meta->'insightShadow'->>'task' = $1
   order by ran_at desc
   limit $2`,
  [task, limit],
);

const rows = res.rows;
const agree = rows.filter((r) => r.shadow?.agree === true).length;
console.log(`task=${task} 样本=${rows.length} 一致=${agree} 一致率=${rows.length ? ((agree / rows.length) * 100).toFixed(1) : 'n/a'}%`);

const disagreements = rows.filter((r) => r.shadow?.agree !== true).slice(0, 20);
if (disagreements.length > 0) {
  console.log('\n分歧样本(最多 20 条,run_id 可回查证据包):');
  for (const r of disagreements) {
    console.log(`- run=${r.id} brand=${r.brand_id} at=${r.ran_at?.toISOString?.() ?? r.ran_at}`);
    console.log(`  rule=${JSON.stringify(r.shadow?.rule)}`);
    console.log(`  llm =${JSON.stringify(r.shadow?.llm)}`);
  }
}
await client.end();
