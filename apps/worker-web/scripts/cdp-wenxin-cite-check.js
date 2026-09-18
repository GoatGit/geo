// 文心(chat.baidu.com/wenxin)引用结构精查:等回答完成后,过滤广告锚点,
// dump 参考资料面板/来源卡结构。用法: node cdp-wenxin-cite-check.js <cdp> [question]
const { chromium } = require('playwright-core');
const cdp = process.argv[2];
const question = process.argv[3] || '2026年20万左右买什么新能源SUV好?结合网络资料推荐';

(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://wenxin.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(8000);
  console.log('[probe] landed:', page.url());

  // 找输入框(新 UI 可能是 textarea 或 contenteditable)
  const input = page.locator('textarea, [contenteditable="true"]').first();
  await input.waitFor({ state: 'visible', timeout: 20000 });
  try { await input.click(); await page.keyboard.insertText(question); } catch { await input.fill(question); }
  await page.waitForTimeout(1200);
  let sent = false;
  for (const sel of ['button:has-text("发送")', '[class*="send"]', 'button[type="submit"]']) {
    if (await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) {
      await page.locator(sel).first().click().catch(() => {});
      sent = true; break;
    }
  }
  if (!sent) await page.keyboard.press('Enter');
  console.log('[probe] submitted');

  // 等回答:文本稳定
  let prev = '', stable = 0;
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(5000);
    let t = 0;
    try { t = await page.evaluate(() => document.body.innerText.length); } catch {}
    if (t === prev && t > 1500) { stable++; if (stable >= 4) break; } else stable = 0;
    prev = t;
  }
  console.log('[probe] stable at', prev, '| url:', page.url());
  await page.waitForTimeout(5000);

  const r = await page.evaluate(() => {
    const out = { url: location.href, realAnchors: [], citePanels: [] };
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      // 过滤广告跳转/站内/协议链接
      if (/baidu\.com\/other\.php|bcebos|javascript:|^\/$|#/.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.realAnchors.push({ href: href.slice(0, 130), text: (a.innerText || '').trim().slice(0, 40), cls: (a.className || '').toString().slice(0, 70) });
    }
    // 引用/来源面板容器
    for (const el of document.querySelectorAll('div,section')) {
      const t = (el.innerText || '');
      if (/参考资料|来源|篇资料|引用来源/.test(t) && t.length < 3000 && el.querySelectorAll('a[href]').length > 0) {
        out.citePanels.push({
          cls: (el.className || '').toString().slice(0, 80),
          links: el.querySelectorAll('a[href]').length,
          text: t.replace(/\s+/g, ' ').slice(0, 150),
        });
        if (out.citePanels.length >= 8) break;
      }
    }
    return out;
  });

  console.log('真实锚点(非广告):', r.realAnchors.length);
  for (const a of r.realAnchors.slice(0, 15)) console.log('  ', JSON.stringify(a));
  console.log('引用面板:');
  for (const p of r.citePanels) console.log('  ', JSON.stringify(p));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message.slice(0, 150)); process.exit(1); });
