// 点开元宝"引用N篇资料"抽屉,dump 抽屉内的链接结构(校准 citationSelectors 用)。
// 用法: node cdp-open-citation-drawer.js <cdp> <engine>
const { chromium } = require('playwright-core');
const pg = require('pg');

const cdp = process.argv[2];
const engine = process.argv[3] || 'yuanbao';
const CHAT_URLS = { yuanbao: 'https://yuanbao.tencent.com/chat' };

(async () => {
  const pdb = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
  await pdb.connect();
  const pr = await pdb.query(
    "SELECT id, cookies FROM account_profiles WHERE engine=$1 AND status='available' AND cookies IS NOT NULL ORDER BY id LIMIT 1",
    [engine],
  );
  await pdb.end();
  const profile = pr.rows[0];
  console.log(`[probe] engine=${engine} profile=${profile.id}`);

  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  await ctx.addCookies(profile.cookies);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(CHAT_URLS[engine], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(9000);

  // 引用工具条候选
  const toolSels = ['[data-toolbar-type="citation"]', '#search-guide-tool', '[aria-label*="篇资料"]'];
  let clicked = false;
  for (const sel of toolSels) {
    const el = page.locator(sel).last();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[probe] clicking', sel);
      await el.click().catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) console.log('[probe] citation tool NOT found');
  await page.waitForTimeout(4000);

  const r = await page.evaluate(() => {
    const out = { url: location.href, anchors: [], drawerText: '' };
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (seen.has(href)) continue;
      seen.add(href);
      out.anchors.push({
        href: href.slice(0, 140),
        text: (a.innerText || '').trim().slice(0, 50),
        cls: (a.className || '').toString().slice(0, 80),
        inDrawer: !!a.closest('[class*="drawer"],[class*="Drawer"],[role="dialog"],[class*="modal"],[class*="panel"]'),
      });
    }
    // 抽屉文本预览
    const drawer = document.querySelector('[class*="drawer"],[class*="Drawer"],[role="dialog"]');
    out.drawerText = drawer ? (drawer.innerText || '').replace(/\s+/g, ' ').slice(0, 400) : '(none)';
    return out;
  });

  console.log('anchors:', r.anchors.length);
  for (const a of r.anchors.slice(0, 30)) console.log(JSON.stringify(a));
  console.log('drawerText:', r.drawerText);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message.slice(0, 150)); process.exit(1); });
