// 引用 DOM 结构探针(带 Cookie 注入,复刻 worker 采集路径):
//   python3 new-cdp-session.py <label>   → 拿 CDP 链接
//   node cdp-cite-cookie-probe.js <cdp> <engine> <answerSel1|answerSel2>
// Cookie 从 account_profiles 读(优先 available 且 cookies 非空),注入后提问并导出引用 DOM。
const { chromium } = require('playwright-core');
const pg = require('pg');

const cdp = process.argv[2];
const engine = process.argv[3] || 'doubao';
const answerSels = (process.argv[4] || '').split('|').filter(Boolean);
const question = process.argv[5] || '2026年20万预算买什么新能源SUV好?家用为主,讲讲各车型优缺点';
const CHAT_URLS = { doubao: 'https://www.doubao.com/chat/', yuanbao: 'https://yuanbao.tencent.com/chat', qwen: 'https://www.qianwen.com/' };

(async () => {
  const pdb = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
  await pdb.connect();
  const pr = await pdb.query(
    "SELECT id, cookies FROM account_profiles WHERE engine=$1 AND status='available' AND cookies IS NOT NULL ORDER BY id LIMIT 1",
    [engine],
  );
  await pdb.end();
  if (pr.rows.length === 0) {
    console.error('NO_COOKIES for', engine);
    process.exit(1);
  }
  const profile = pr.rows[0];
  console.log(`[probe] engine=${engine} profile=${profile.id} cookies=${profile.cookies.length}`);

  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  await ctx.addCookies(profile.cookies);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(CHAT_URLS[engine] || CHAT_URLS.doubao, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(9000);
  console.log('[probe] landed:', page.url());

  for (const sel of ['button:has-text("我知道了")', 'button:has-text("同意")', 'button:has-text("确定")']) {
    await page.locator(sel).first().click({ timeout: 800 }).catch(() => {});
  }

  const input = page.locator('[contenteditable="true"], textarea').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  try {
    await input.click();
    await page.keyboard.insertText(question);
  } catch {
    await input.fill(question);
  }
  await page.waitForTimeout(1500);
  const sendSel = ['button[class*="highlight"]', 'button:has-text("发送")', 'button[type="submit"]', '#sendBtn', 'div[class*="send"][role="button"]'];
  let sent = false;
  for (const sel of sendSel) {
    if (await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) {
      await page.locator(sel).first().click().catch(() => {});
      sent = true;
      break;
    }
  }
  if (!sent) await page.keyboard.press('Enter');
  console.log('[probe] submitted, waiting for answer...');

  let prev = '';
  let stable = 0;
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(5000);
    let t = 0;
    try {
      t = await page.evaluate(() => document.body.innerText.length);
    } catch {}
    if (t === prev && t > 800) { stable++; if (stable >= 4) break; } else stable = 0;
    prev = t;
  }
  console.log('[probe] body text length stable at', prev);
  await page.waitForTimeout(5000);

  const r = await page.evaluate((aSels) => {
    const out = { url: location.href, anchors: [], structural: [], answerScope: [] };
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (seen.has(href)) continue;
      seen.add(href);
      out.anchors.push({
        href: href.slice(0, 130),
        cls: (a.className || '').toString().slice(0, 70),
        text: (a.innerText || '').trim().slice(0, 30),
        parentCls: (a.parentElement?.className || '').toString().slice(0, 70),
      });
      if (out.anchors.length >= 50) break;
    }
    const clsHit = /cite|source|reference|search|web|quote|ref|jugement|refer/i;
    const hitMap = new Map();
    for (const el of document.querySelectorAll('div,span,section,ul')) {
      const c = (el.className || '').toString();
      if (clsHit.test(c) && el.querySelectorAll('a[href]').length > 0) {
        const key = c.slice(0, 60);
        if (!hitMap.has(key))
          hitMap.set(key, { cls: key, links: el.querySelectorAll('a[href]').length, text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 100) });
      }
      if (hitMap.size >= 15) break;
    }
    out.structural = [...hitMap.values()];
    out.supCount = document.querySelectorAll('sup, [class*="citation"], [class*="footnote"]').length;
    out.answerScope = (aSels || []).map((s) => {
      const els = Array.from(document.querySelectorAll(s));
      const last = els[els.length - 1];
      return { sel: s, count: els.length, linksInLast: last ? last.querySelectorAll('a[href]').length : 0 };
    });
    return out;
  }, answerSels);

  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => {
  console.error('FATAL', e.message.slice(0, 150));
  process.exit(1);
});
