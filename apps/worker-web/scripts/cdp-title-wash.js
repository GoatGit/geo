// 引用标题 CDP 清洗:AgentBay 真实 Chrome(国内出口)打开缺标题 URL,
// 读取 document.title / og:title——JS 渲染(头条/易车)与反爬(知乎)均可过。
// 用法: node cdp-title-wash.js <cdpLink> [并发页签数=3]
const { chromium } = require('playwright-core');
const pg = require('pg');

const CONCURRENCY = Number(process.argv[3] ?? 1);
// AgentBay 会话有 TTL,长跑必被回收:限量分批,每批新会话(WASH_MAX 控制批量)
const MAX_PER_SESSION = Number(process.env.WASH_MAX ?? 999);
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
  // 头条系对连续请求限流(实测:同 URL 单页慢速可取,连续并发变登录墙)——
  // 单 worker + 每条间隔 3s + 可修家族优先
  const HEALTHY = /(toutiao|yiche|bitauto|autohome|hkexnews|163\.com|pcauto|ccn\.com|cnmo|zol|ifeng|sohu|sina|xueqiu)/i;
  const healthy = rows.filter((r) => HEALTHY.test(r.raw_url)).map((r) => r.raw_url);
  const rest = rows.filter((r) => !HEALTHY.test(r.raw_url)).map((r) => r.raw_url);
  const queue = [...healthy, ...rest];

  const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

  async function worker(idx) {
    // 持久页签(真人式连续浏览;头条对"每条新开页签"反bot,实测)+ 硬超时竞速防失速
    let page = await race(ctx.newPage(), 8000);
    while (true) {
      if (done >= MAX_PER_SESSION) break;
      const i = queue.shift();
      if (i === undefined) break;
      const url = i;
      let title = null;
      try {
        if (!page || page.isClosed?.()) page = await race(ctx.newPage(), 8000);
        if (page) {
          const went = await race(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }), 18000).catch(() => 'err');
          if (went === null) {
            // goto 失速:丢弃页签重建
            await race(page.close(), 3000).catch(() => {});
            page = await race(ctx.newPage(), 8000);
          } else {
            await page.waitForTimeout(4500).catch(() => {});
            title = await race(
              page.evaluate(() => {
                const t = document.title?.trim();
                if (t && t.length >= 4 && t.length <= 120) return t;
                const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
                if (og && og.length >= 4 && og.length <= 120) return og;
                return null;
              }),
              8000,
            ).catch(() => null);
          }
        }
      } catch {
        await race(page?.close(), 3000).catch(() => {});
        page = await race(ctx.newPage(), 8000);
      }
      if (process.env.WASH_VERBOSE && done < 30) console.log(url.slice(8, 48), '=>', JSON.stringify(String(title).slice(0, 32)));
      if (title && !JUNK.test(title)) {
        await c.query("UPDATE citation_facts SET title=$1 WHERE raw_url=$2 AND (title IS NULL OR title='')", [title.slice(0, 120), url]).catch(() => {});
        fixed++;
        if (fixed % 20 === 0) console.log(`  进度 ${done + 1}/${rows.length} 已修 ${fixed}`);
      } else {
        dead++;
      }
      done++;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await race(page?.close(), 3000).catch(() => {});
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const left = await c.query("SELECT COUNT(*)::int n FROM citation_facts WHERE title IS NULL OR title=''");
  const total = await c.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE title IS NOT NULL AND title<>'')::int ok FROM citation_facts");
  console.log(`完成:修复 ${fixed} 个 URL,无标题/失效 ${dead} | 剩余缺标题行 ${left.rows[0].n}`);
  console.log(`全量覆盖: ${total.rows[0].ok}/${total.rows[0].total} ${Math.round((total.rows[0].ok / total.rows[0].total) * 100)}%`);
  await c.end();
  await browser.close().catch(() => {});
})().catch((e) => { console.error('FATAL', e.message.slice(0, 120)); process.exit(1); });
