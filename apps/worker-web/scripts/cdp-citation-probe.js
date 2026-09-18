// 引用 DOM 结构探针:提交一题,等回答完成后导出引用相关 DOM。
// 用法: node cdp-citation-probe.js <cdpLink> <chatUrl> <question> <answerSel1|answerSel2>
const { chromium } = require('playwright-core');
const cdp = process.argv[2];
const chatUrl = process.argv[3];
const question = process.argv[4] || '2026年20万预算买什么新能源SUV好?';
const answerSels = (process.argv[5] || '').split('|').filter(Boolean);

(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(8000);

  // 关闭可能的弹窗
  for (const sel of ['button:has-text("我知道了")', 'button:has-text("同意")', '[class*="close"]']) {
    await page.locator(sel).first().click({ timeout: 800 }).catch(() => {});
  }

  // 输入并发送
  const input = page.locator('[contenteditable="true"], textarea').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  try {
    await input.click();
    await page.keyboard.insertText(question);
  } catch {
    await input.fill(question);
  }
  await page.waitForTimeout(1200);
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

  // 等回答完成:文本稳定
  let prev = '';
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);
    let t = 0;
    try {
      t = await page.evaluate(() => document.body.innerText.length);
    } catch { t = 0; }
    if (t === prev && t > 500) { stable++; if (stable >= 3) break; } else stable = 0;
    prev = t;
  }
  console.log('[probe] body text length stable at', prev);
  await page.waitForTimeout(4000);

  const r = await page.evaluate((aSels) => {
    const out = { url: location.href, anchors: [], structural: [] };

    // 1) 全页所有 http 锚点(按 href 域名归类,取类名链)
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (seen.has(href)) continue;
      seen.add(href);
      out.anchors.push({
        href: href.slice(0, 120),
        cls: (a.className || '').toString().slice(0, 60),
        text: (a.innerText || '').trim().slice(0, 30),
        parentCls: (a.parentElement?.className || '').toString().slice(0, 60),
      });
      if (out.anchors.length >= 40) break;
    }

    // 2) 引用语义结构:类名含 cite/source/reference/search/web 的容器
    const clsHit = /cite|source|reference|search|web|quote|ref/i;
    const hitMap = new Map();
    for (const el of document.querySelectorAll('div,span,section,ul')) {
      const c = (el.className || '').toString();
      if (clsHit.test(c) && el.querySelectorAll('a[href]').length > 0) {
        const key = c.slice(0, 50);
        if (!hitMap.has(key)) hitMap.set(key, { cls: key, links: el.querySelectorAll('a[href]').length, childText: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120) });
      }
      if (hitMap.size >= 12) break;
    }
    out.structural = [...hitMap.values()];

    // 3) 引用角标候选:sup / [1] 样式
    out.supCount = document.querySelectorAll('sup, [class*="citation"], [class*="footnote"]').length;

    // 4) 回答容器内的锚点数(用调用方给的 answerSelectors 语义"任一命中")
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
