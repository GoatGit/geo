const { chromium } = require('playwright-core');
const cdp = process.argv[2], chatUrl = process.argv[3];
const selectors = (process.argv[4] || '').split('|');
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto:', e.message.slice(0, 60)));
  await page.waitForTimeout(8000);
  const r = await page.evaluate((sels) => {
    const found = sels.map(s => ({ sel: s, count: document.querySelectorAll(s).length, visible: Array.from(document.querySelectorAll(s)).some(el => el.offsetParent !== null || el.getClientRects().length) }));
    return {
      url: location.href,
      title: document.title.slice(0, 40),
      textareas: document.querySelectorAll('textarea, [contenteditable="true"], div[contenteditable]').length,
      found,
      bodySnippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 150),
      cookieNames: document.cookie.split(';').map(c => c.split('=')[0].trim()).slice(0, 10),
    };
  }, selectors);
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 120)); process.exit(1); });
