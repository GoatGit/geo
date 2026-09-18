// 一次性回填:修复 citation_facts 里 cp1252 mojibake 标题(网络收割器 v42 前的存量数据)。
// 用法: DATABASE_URL=... node scripts/backfill-citation-titles.mjs [--apply]
import { createRequire } from 'node:module';
const requirePg = createRequire('/Users/yanghuaiyuan/AI/geo/apps/worker-web/package.json');
const pg = requirePg('pg');

const APPLY = process.argv.includes('--apply');
const CP1252_HIGH = { 0x20ac:0x80, 0x201a:0x82, 0x0192:0x83, 0x201e:0x84, 0x2026:0x85, 0x2020:0x86, 0x2021:0x87, 0x02c6:0x88, 0x2030:0x89, 0x0160:0x8a, 0x2039:0x8b, 0x0152:0x8c, 0x017d:0x8e, 0x2018:0x91, 0x2019:0x92, 0x201c:0x93, 0x201d:0x94, 0x2022:0x95, 0x2013:0x96, 0x2014:0x97, 0x02dc:0x98, 0x2122:0x99, 0x0161:0x9a, 0x203a:0x9b, 0x0153:0x9c, 0x017e:0x9e, 0x0178:0x9f };

function mojibakeToUtf8(s) {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff) bytes.push(cp);
    else if (CP1252_HIGH[cp] !== undefined) bytes.push(CP1252_HIGH[cp]);
    else return null;
  }
  const out = Buffer.from(bytes).toString('utf8');
  return out.includes('\uFFFD') ? null : out;
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await c.connect();
const rows = await c.query(
  "SELECT id, title FROM citation_facts WHERE title ~ '[\\u00C0-\\u00FF][\\u0080-\\u00FF]'",
);
let fixed = 0;
let skipped = 0;
for (const row of rows.rows) {
  const restored = mojibakeToUtf8(row.title);
  if (restored && restored !== row.title) {
    fixed++;
    if (APPLY) {
      await c.query('UPDATE citation_facts SET title = $1 WHERE id = $2', [restored, row.id]);
    }
  } else {
    skipped++;
  }
}
console.log(`乱码行 ${rows.rows.length}:可还原 ${fixed},不可还原 ${skipped}${APPLY ? ' → 已回填' : ' (dry-run,加 --apply)'}`);
await c.end();
