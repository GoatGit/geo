const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  const r = await page.evaluate(async (url) => {
    try { await fetch(url, { signal: AbortSignal.timeout(8000) }); return 'fetch-done'; }
    catch (e) { return (e.message || String(e)).slice(0, 60); }
  }, 'http://221.216.147.115:18099/ping');
  console.log('laptop-port:', r);
  await browser.close();
})().catch(e => console.error('FATAL', e.message.slice(0, 80)));