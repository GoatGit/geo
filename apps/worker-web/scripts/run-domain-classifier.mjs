// 一次性/手动运行域名 LLM 分类器(与 worker 内置循环同一实现)。
// 用法: DATABASE_URL=... node scripts/run-domain-classifier.mjs [limit]
import { createDb } from '@geo/db';
import { classifyUnknownDomains } from '../dist/domain-classifier.js';
const { pool, db } = createDb(process.env.DATABASE_URL);
let total = 0;
for (let i = 0; i < 4; i++) {
  const n = await classifyUnknownDomains(db, Number(process.argv[2] ?? 8));
  total += n;
  console.log(`round ${i + 1}: 新增字典 ${n}`);
  if (n === 0) break;
}
import { sql as dsql } from 'drizzle-orm';
const left = await db.execute(dsql`select count(*)::int as n from citation_facts where platform_category='unknown'`);
console.log('新增合计:', total, '| 剩余 unknown 引用行:', left.rows[0].n);
await pool.end();
