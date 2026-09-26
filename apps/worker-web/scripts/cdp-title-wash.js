// 引用标题 CDP 清洗:AgentBay 真实 Chrome(国内出口)打开缺标题 URL,
// 读取 document.title / og:title——JS 渲染(头条/易车)与反爬(知乎)均可过。
// 用法: node cdp-title-wash.js <cdpLink> [并发页签数=3]
const { chromium } = require('playwright-core');
const pg = require('pg');

const CONCURRENCY = Number(process.argv[3] ?? 3);
/** 渲染出的占位/失效页标题不算标题 */
const JUNK = /内容不存在|已删除|账号迁移|访问受限|安全验证|登录|微信公众平台|微博|抱歉/;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  await c.connect();
  const { rows } = await c.query(
    "SELECT raw_url, COUNT(*)::int n FROM citation_facts WHERE title IS NULL OR title='' GROUP BY 1 ORDER BY 2 DESC",
  );
  console.log(`待清洗 URL: ${rows.length}`);
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const ctx = browser.contexts()[0] || (await browser.newContext());

  let fixed = 0, dead = 0, done = 0;
  const queue = rows.map((r) => r.raw_url);

  async function worker(idx) {
    const page = await ctx.newPage();
    try {
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (['image', 'media', 'font'].includes(t)) return route.abort();
        return route.continue();
      });
    } catch {}
    while (true) {
      const i = queue.shift();
      if (i === undefined) break;
      const url = i;
      let title = null;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2500);
        title = await page.evaluate(() => {
          const t = document.title?.trim();
          if (t && t.length >= 4 && t.length <= 120) return t;
          const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
          if (og && og.length >= 4 && og.length <= 120) return og;
          return null;
        }).catch(() => null);
      } catch {}
      if (title && !JUNK.test(title)) {
        await c.query("UPDATE citation_facts SET title=$1 WHERE raw_url=$2 AND (title IS NULL OR title='')", [title.slice(0, 120), url]).catch(() => {});
        fixed++;
        if (fixed % 20 === 0) console.log(`  进度 ${done + 1}/${rows.length} 已修 ${fixed}`);
      } else {
        dead++;
      }
      done++;
    }
    await page.close().catch(() => {});
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const left = await c.query("SELECT COUNT(*)::int n FROM citation_facts WHERE title IS NULL OR title=''");
  const total = await c.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE title IS NOT NULL AND title<>'')::int ok FROM citation_facts");
  console.log(`完成:修复 ${fixed} 个 URL,无标题/失效 ${dead} | 剩余缺标题行 ${left.rows[0].n}`);
  console.log(`全量覆盖: ${total.rows[0].ok}/${total.rows[0].total} ${Math.round((total.rows[0].ok / total.rows[0].total) * 100)}%`);
  await c.end();
  await browser.close().catch(() => {});
})().catch((e) => { console.error('FATAL', e.message.slice(0, 120)); process.exit(1); });
