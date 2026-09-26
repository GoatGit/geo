import pg from 'pg';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/&#x?[0-9a-f]+;/gi,' ').replace(/\s+/g,' ').trim();
  return t.length >= 4 && t.length <= 120 ? t : null;
}
async function fetchTitle(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const buf = await res.arrayBuffer().then((b) => b.slice(0, 96 * 1024));
    return extractTitle(new TextDecoder('utf-8', { fatal: false }).decode(buf));
  } catch { return null; }
}
const c = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await c.connect();
const failed = new Set();
let total = 0;
for (let round = 0; round < 8; round++) {
  const r = await c.query("select id, raw_url from citation_facts where (title is null or title='') order by id desc limit 200");
  const rows = r.rows.filter((x) => !failed.has(x.raw_url)).slice(0, 100);
  if (rows.length === 0) break;
  let fixed = 0;
  for (let i = 0; i < rows.length; i += 10) {
    await Promise.all(rows.slice(i, i + 10).map(async (row) => {
      const t = await fetchTitle(row.raw_url);
      if (t) { await c.query("update citation_facts set title=$1 where id=$2 and (title is null or title='')", [t, row.id]); fixed++; }
      else failed.add(row.raw_url);
    }));
  }
  total += fixed;
  console.log(`round ${round + 1}: +${fixed}`);
  if (fixed === 0) break;
}
console.log('共补齐:', total);
const left = await c.query("select count(*)::int n from citation_facts where title is null or title=''");
console.log('剩余缺标题:', left.rows[0].n);
await c.end();
