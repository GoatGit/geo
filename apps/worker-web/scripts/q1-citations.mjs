import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await c.connect();

let r = await c.query(`
  SELECT qr.engine, qr.status, COUNT(*)::int AS n
  FROM query_runs qr JOIN collection_rounds r2 ON qr.round_id = r2.id
  WHERE r2.started_at > now() - interval '3 days'
  GROUP BY 1,2 ORDER BY 1,2`);
console.log('== query_runs by engine/status (3d) ==');
for (const row of r.rows) console.log(row.engine.padEnd(10), row.status.padEnd(15), row.n);

r = await c.query(`
  SELECT qr.engine,
         COUNT(DISTINCT qr.id)::int AS runs_ok,
         COUNT(DISTINCT CASE WHEN cf.id IS NOT NULL THEN qr.id END)::int AS runs_with_cite,
         COUNT(cf.id)::int AS citations
  FROM query_runs qr
  JOIN collection_rounds r2 ON qr.round_id = r2.id
  LEFT JOIN citation_facts cf ON cf.run_id = qr.id
  WHERE r2.started_at > now() - interval '3 days' AND qr.status = 'ok_with_answer'
  GROUP BY 1 ORDER BY 1`);
console.log('== citation_facts by engine (3d, ok_with_answer) ==');
for (const row of r.rows) console.log(row.engine.padEnd(10), 'runs_ok:', String(row.runs_ok).padEnd(5), 'runs_with_cite:', String(row.runs_with_cite).padEnd(5), 'citations:', row.citations);

r = await c.query(`SELECT engine, COUNT(*)::int AS n, MAX(extracted_at) AS latest FROM citation_facts GROUP BY 1 ORDER BY 1`);
console.log('== citation_facts all-time by engine ==');
for (const row of r.rows) console.log(row.engine.padEnd(10), 'n:', String(row.n).padEnd(6), 'latest:', row.latest?.toISOString?.() ?? row.latest);

r = await c.query(`SELECT id, brand_id, name FROM brands ORDER BY id`);
console.log('== brands ==');
for (const row of r.rows) console.log(row.id, row.brand_id !== undefined ? '' : '', row.name);
await c.end();
