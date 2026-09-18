// 存量口碑事实的 GLM 重判回填:取近 N 天 reputation_facts(规则降级路径的产物),
// 从 OSS 证据取回答原文,调 Insight Agent 同源判定(prompt/schema 与 judgeReputation 一致),
// 更新 sentiment/confidence/impression_terms/excerpt/audit_state/parser_version。
// 用法: DATABASE_URL=... S3_AK=... S3_SK=... node scripts/rejudge-reputation.mjs [--apply]
import { createRequire } from 'node:module';
const requirePg = createRequire('/Users/yanghuaiyuan/AI/geo/apps/worker-web/package.json');
const requireS3 = createRequire('/Users/yanghuaiyuan/AI/geo/packages/evidence/package.json');
const pg = requirePg('pg');
const { S3Client, GetObjectCommand } = requireS3('@aws-sdk/client-s3');

const APPLY = process.argv.includes('--apply');
const DAYS = Number(process.argv[2]?.match(/^\d+$/)?.[0] ?? 2);

const s3 = new S3Client({
  region: 'cn-hangzhou',
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  credentials: { accessKeyId: process.env.S3_AK, secretAccessKey: process.env.S3_SK },
  forcePathStyle: false,
});
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await c.connect();

// 判定配置与生产 platform_settings.insightAgent 一致
const cfgRow = await c.query("SELECT value FROM platform_settings WHERE key = 'insightAgent'");
const cfg = cfgRow.rows[0].value;
const brand = (await c.query('SELECT name FROM brands WHERE id = 9')).rows[0]?.name ?? '';

async function judge(brandName, answerText) {
  const system =
    '你是 GEO 口碑分析引擎。只输出一个 JSON 对象,不要多余文字。' +
    'schema: {"sentiment":"pos|neu|neg","confidence":0~1,"impressions":[{"term":"具体印象短语(2-12字,来自原文的实质评价,如\'下摆臂异响\'\'家庭用户满意度高\',禁止用\'投诉\'\'慢\'这类单词)","polarity":"pos|neu|neg","excerpt":"该印象在原文中的原句(≤60字)"}],"answerEmpty":false}。' +
    'impressions 2-6 条;confidence 为判定置信度;仅针对品牌本体,竞品的印象不要收录。';
  const user = `品牌: ${brandName}\n回答原文:\n${answerText.slice(0, 4000)}`;
  const t0 = Date.now();
  const res = await fetch(cfg.endpoint + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json in response');
  const parsed = JSON.parse(m[0]);
  console.log(`   [llm ${Date.now() - t0}ms] sentiment=${parsed.sentiment} conf=${parsed.confidence} terms=${parsed.impressions?.length}`);
  return parsed;
}

const rows = await c.query(
  `SELECT rf.id, rf.run_id, qr.engine FROM reputation_facts rf JOIN query_runs qr ON qr.id = rf.run_id
   WHERE rf.brand_id = 9 AND rf.ran_at > now() - ($1 || ' days')::interval AND rf.parser_version NOT LIKE 'insight@%'
   ORDER BY rf.id`,
  [DAYS],
);
console.log(`待重判(规则路径产物): ${rows.rows.length} 条`);

for (const row of rows.rows) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: 'gemux-geo-evidence', Key: `evidence/${row.run_id}/answer.json` }));
    const d = JSON.parse(await res.Body.transformToString());
    const answerText = d.answerText ?? '';
    const questionText = d.question ?? '';
    if (answerText.trim().length < 30) {
      console.log(`run ${row.run_id}: 回答过短跳过`);
      continue;
    }
    const judged = await judge(brand, answerText);
    if (!judged?.sentiment) continue;
    const terms = (judged.impressions ?? []).slice(0, 6).map((t) => ({
      term: String(t.term ?? '').slice(0, 24),
      polarity: t.polarity === 'pos' ? 'pos' : t.polarity === 'neg' ? 'neg' : 'neu',
      excerpt: String(t.excerpt ?? '').slice(0, 120),
    }));
    // 证据摘要:跳过元信息行与问题回显
    const noise = /^搜索|^已搜索|^已完成分析|^共参考|篇资料[。]?$/;
    const q = questionText.replace(/\s+/g, '');
    let excerpt = terms[0]?.excerpt ?? null;
    for (const raw of answerText.split(/[。;;\n!?]/)) {
      const s = raw.trim();
      if (s.length < 12 || noise.test(s)) continue;
      const norm = s.replace(/\s+/g, '');
      if (q && (norm.includes(q) || (norm.length <= q.length + 4 && q.includes(norm)))) continue;
      excerpt = s.slice(0, 120);
      break;
    }
    const conf = Number(judged.confidence) || 0.8;
    if (APPLY) {
      await c.query(
        `UPDATE reputation_facts SET sentiment=$1, confidence=$2, impression_terms=$3::jsonb, excerpt=$4, audit_state=$5, parser_version=$6 WHERE id=$7`,
        [
          ['pos', 'neu', 'neg'].includes(judged.sentiment) ? judged.sentiment : 'neu',
          conf,
          JSON.stringify(terms),
          excerpt,
          conf >= 0.9 ? 'auto' : 'pending',
          `insight@rejudge+openai/${cfg.model}`,
          row.id,
        ],
      );
    }
  } catch (e) {
    console.log(`run ${row.run_id}: 重判失败 ${e.message.slice(0, 80)}`);
  }
}
console.log(APPLY ? '回填完成' : '(dry-run,加 --apply)');
await c.end();
