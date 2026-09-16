/**
 * 一次性运维脚本:删除指定品牌及其全部从属数据(SAE 一次性任务/本地运行)。
 * 用法: BRAND_ID=10 DATABASE_URL=... node apps/worker-web/scripts/oneoff-cleanup-brand.mjs
 * 删除范围:事实层/轮次/计划/问题/口径/报告/订阅 + 品牌本体。谨慎使用(不可逆)。
 */
import { Client } from 'pg';

const brandId = Number(process.env.BRAND_ID);
if (!brandId || !Number.isInteger(brandId)) {
  console.error('BRAND_ID required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const TABLES = [
  'audit_tasks',
  'mention_facts',
  'citation_facts',
  'reputation_facts',
  'query_runs',
  'daily_metrics',
  'collection_rounds',
  'collection_plans',
  'monitoring_questions',
  'recognition_entries',
  'recognition_versions',
  'competitor_candidates',
  'reports',
  'subscriptions',
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
for (const table of TABLES) {
  const r = await client.query(`delete from ${table} where brand_id = $1`, [brandId]);
  if (r.rowCount > 0) console.log(`  ${table}: ${r.rowCount} rows deleted`);
}
const b = await client.query('delete from brands where id = $1', [brandId]);
console.log(`brands: ${b.rowCount} deleted (id=${brandId})`);
await client.end();
console.log('CLEANUP_DONE');
