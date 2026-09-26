import { chromium } from 'playwright-core';
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await c.connect();
const { rows } = await c.query("SELECT raw_url FROM citation_facts WHERE (title IS NULL OR title='') AND domain IN ('toutiao.com','m.toutiao.com') GROUP BY 1 LIMIT 15");
const browser = await chromium.connectOverCDP(process.argv[2]);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
for (const { raw_url } of rows) {
  try {
    await page.goto(raw_url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log('  goto-catch:', e.message.slice(0, 40)));
    await page.waitForTimeout(3500);
    const t = await page.evaluate(() => ({ title: document.title?.trim() ?? '', og: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '' })).catch((e) => ({ title: 'EVAL-ERR:' + e.message.slice(0, 30) }));
    console.log(raw_url.slice(8, 52).padEnd(46), '=>', JSON.stringify((t.title || t.og || '').slice(0, 44)));
  } catch (e) { console.log(raw_url.slice(8, 55), 'OUT:', e.message.slice(0, 50)); }
}
await c.end();
await browser.close();
