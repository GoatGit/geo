/* 引用结构探针(复用生产 WebAdapter 完整流程):
 *   python3 new-cdp-session.py probe  → CDP 链接
 *   node adapter-cite-probe.mjs <cdp> <engine> [question]
 * Cookie 注入同 worker;ask 后落盘 rawHtml 供离线分析引用卡片 DOM。 */
import { chromium } from 'playwright-core';
import pg from 'pg';
import { DomWebAdapter } from '@geo/engine-adapters';
import { writeFileSync } from 'node:fs';

const cdp = process.argv[2];
const engine = process.argv[3] || 'doubao';
const question = process.argv[4] || '2026年20万左右预算买什么新能源SUV好?请结合网络资料推荐具体车型';

const pdb = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await pdb.connect();
const pr = await pdb.query(
  "SELECT id, cookies FROM account_profiles WHERE engine=$1 AND status='available' AND cookies IS NOT NULL ORDER BY id LIMIT 1",
  [engine],
);
await pdb.end();
if (pr.rows.length === 0) { console.error('NO_COOKIES for', engine); process.exit(1); }
const profile = pr.rows[0];
console.log(`[probe] engine=${engine} profile=${profile.id} cookies=${profile.cookies.length}`);

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] || (await browser.newContext());
await ctx.addCookies(profile.cookies);
const page = ctx.pages()[0] || (await ctx.newPage());

const adapter = new DomWebAdapter(engine);
const t0 = Date.now();
const result = await adapter.ask({ page, profileKey: `probe-${profile.id}` }, question, { timeoutMs: 150_000 });
console.log(`[probe] ask done in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('status:', result.status);
console.log('engineMeta:', JSON.stringify(result.engineMeta));
console.log('citations:', result.citations.length, JSON.stringify(result.citations.slice(0, 5), null, 1));
console.log('answerText head:', (result.answerText || '').slice(0, 200).replace(/\n/g, ' '));
if (result.rawHtml) {
  writeFileSync(`/tmp/probe-${engine}-raw.html`, result.rawHtml);
  console.log(`rawHtml saved: /tmp/probe-${engine}-raw.html (${Math.round(result.rawHtml.length / 1024)}KB)`);
}

// ask 后原地点开引用抽屉(元宝:引用源在折叠抽屉,DOM 默认无链接)
const toolSels = ['[data-toolbar-type="citation"]', '#search-guide-tool', '[aria-label*="篇资料"]', '[class*="reference"]', '[class*="source-list"]'];
let clicked = false;
for (const sel of toolSels) {
  const el = page.locator(sel).last();
  if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
    console.log('[drawer] clicking', sel);
    await el.click().catch(() => {});
    clicked = true;
    break;
  }
}
if (!clicked) console.log('[drawer] citation tool NOT found');
await page.waitForTimeout(6000);
// 全页诊断:frames、类容器清单、全部锚点
const frames = page.frames().map((f) => f.url().slice(0, 80));
console.log('[drawer] frames:', JSON.stringify(frames, null, 0));
const dump = await page.evaluate(() => {
  const seen = new Set();
  const anchors = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (seen.has(href)) continue;
    seen.add(href);
    anchors.push({ href: href.slice(0, 140), text: (a.innerText || '').trim().slice(0, 40) });
  }
  const boxes = [];
  for (const el of document.querySelectorAll('div,section,aside')) {
    const c = (el.className || '').toString();
    if (/drawer|dialog|panel|popup|popover|aside|modal|citation|refer|source/i.test(c)) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 30) boxes.push({ cls: c.slice(0, 90), len: t.length, text: t.slice(0, 120) });
    }
  }
  return { anchors, boxes: boxes.slice(0, 15) };
});
console.log('[drawer] anchors:', dump.anchors.length);
for (const a of dump.anchors.slice(0, 20)) console.log('  ', JSON.stringify(a));
console.log('[drawer] candidate containers:');
for (const b of dump.boxes) console.log('  ', JSON.stringify(b));
await browser.close();
