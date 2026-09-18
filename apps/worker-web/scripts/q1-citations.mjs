// 引用数据分布速查:各引擎任务状态 + citation_facts 出数(近 N 天窗口)。
// 用法: DATABASE_URL=postgres://... node scripts/q1-citations.mjs [days]
import pg from 'pg';

const days = Number(process.argv[2] || 3);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await c.connect();

let r = await c.query(
  `SELECT engine, status, COUNT(*)::int AS n
   FROM query_runs WHERE ran_at > now() - ($1 || ' days')::interval
   GROUP BY 1,2 ORDER BY 1,2`, [days]);
console.log(`== query_runs by engine/status (${days}d) ==`);
for (const row of r.rows) console.log(row.engine.padEnd(10), row.status.padEnd(15), row.n);

r = await c.query(
  `SELECT qr.engine,
          COUNT(DISTINCT qr.id)::int AS runs_ok,
          COUNT(DISTINCT CASE WHEN cf.id IS NOT NULL THEN qr.id END)::int AS runs_with_cite,
          COUNT(cf.id)::int AS citations
   FROM query_runs qr
   LEFT JOIN citation_facts cf ON cf.run_id = qr.id
   WHERE qr.status = 'ok_with_answer' AND qr.ran_at > now() - ($1 || ' days')::interval
   GROUP BY 1 ORDER BY 1`, [days]);
console.log(`== citation_facts by engine (${days}d, ok_with_answer) ==`);
for (const row of r.rows)
  console.log(row.engine.padEnd(10), 'runs_ok:', String(row.runs_ok).padEnd(5), 'runs_with_cite:', String(row.runs_with_cite).padEnd(5), 'citations:', row.citations);

await c.end();
