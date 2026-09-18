const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto('http://125.124.106.64:18080', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    console.log('PROXY_PAGE:', (await page.locator('body').innerText({ timeout: 2000 })).trim().slice(0, 150));
  } catch (e) { console.log('nav:', e.message.slice(0, 80)); }
  await browser.close();
})().catch(e => console.error('FATAL', e.message.slice(0, 80)));