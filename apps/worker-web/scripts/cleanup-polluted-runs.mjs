/* 清理被适配器误判污染的真实采集 run(品牌 9/12):
 * 证据 answerText < 120 字符或含侧栏特征 → run 置 failed + 删除派生事实。
 * 用法: node cleanup-polluted-runs.mjs        # dry-run
 *       node cleanup-polluted-runs.mjs --apply */
import { createRequire } from 'node:module';
const requireS3 = createRequire('/Users/yanghuaiyuan/AI/geo/packages/evidence/package.json');
const requirePg = createRequire('/Users/yanghuaiyuan/AI/geo/apps/worker-web/package.json');
const { S3Client, GetObjectCommand } = requireS3('@aws-sdk/client-s3');
const pg = requirePg('pg');

const APPLY = process.argv.includes('--apply');
const s3 = new S3Client({
  region: 'cn-hangzhou',
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  credentials: { accessKeyId: process.env.S3_AK, secretAccessKey: process.env.S3_SK },
  forcePathStyle: false,
});

const c = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await c.connect();
const runs = await c.query(
  "SELECT id, engine FROM query_runs WHERE status='ok_with_answer' AND brand_id IN (9,12) ORDER BY id",
);
const garbage = [];
for (const row of runs.rows) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: 'gemux-geo-evidence', Key: `evidence/${row.id}/answer.json` }));
    const d = JSON.parse(await res.Body.transformToString());
    const text = d.answerText ?? '';
    if (text.length < 120 || /快速回答\nAI 生图|AI 生图\n写作/.test(text)) garbage.push(row.id);
  } catch {
    console.log(`run ${row.id} evidence 读取失败,跳过`);
  }
}
console.log(`brand 9/12 ok runs: ${runs.rows.length}, 待清理: ${garbage.length} → [${garbage.join(',')}]`);

if (APPLY && garbage.length > 0) {
  await c.query("UPDATE query_runs SET status='failed' WHERE id = ANY($1)", [garbage]);
  await c.query(
    "UPDATE query_runs SET meta = jsonb_set(COALESCE(meta,'{}'::jsonb), ARRAY['error'], $2) WHERE id = ANY($1)",
    [garbage, '回答为站点侧栏/推荐位文本(适配器误判,已清理待重采)'],
  );
  const m = await c.query('DELETE FROM mention_facts WHERE run_id = ANY($1)', [garbage]);
  const r2 = await c.query('DELETE FROM reputation_facts WHERE run_id = ANY($1)', [garbage]);
  const c2 = await c.query('DELETE FROM citation_facts WHERE run_id = ANY($1)', [garbage]);
  console.log(`已置 failed;删除 mention_facts ${m.rowCount} / reputation_facts ${r2.rowCount} / citation_facts ${c2.rowCount} 行`);
} else {
  console.log('(dry-run,加 --apply 执行)');
}
await c.end();
