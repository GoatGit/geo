const { chromium } = require('playwright-core');
const cdp = process.argv[2], chatUrl = process.argv[3];
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(10000);
  const r = await page.evaluate(() => {
    const out = { sendBtn: !!document.querySelector('#sendBtn'), dataSend: !!document.querySelector('button[data-testid="send"]'), sendText: null, candidates: [] };
    const sendText = Array.from(document.querySelectorAll('button, span, div[role="button"]')).filter(el => /发送|提交/.test(el.textContent || '') && (el.textContent || '').length < 10);
    out.sendText = sendText.slice(0, 3).map(el => el.tagName + ':' + el.className.toString().slice(0, 50));
    const ta = document.querySelector('textarea');
    if (ta) {
      const form = ta.closest('form');
      out.formButtons = form ? Array.from(form.querySelectorAll('button')).map(b => b.id + '|' + b.className.toString().slice(0, 40)) : [];
      out.taPlaceholder = ta.placeholder || '(无)';
    }
    const allBtns = Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, cls: b.className.toString().slice(0, 40), aria: b.getAttribute('aria-label'), txt: (b.textContent || '').trim().slice(0, 12) })).filter(b => b.aria || b.id);
    out.ariaButtons = allBtns.slice(0, 12);
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 100)); process.exit(1); });
