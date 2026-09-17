const { chromium } = require('playwright-core');
const cdp = process.argv[2];
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const url of ['https://www.baidu.com', 'https://httpbin.org/ip', 'https://ifconfig.me/ip']) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2000);
      const t = (await page.locator('body').innerText({ timeout: 3000 })).trim().replace(/\s+/g, ' ');
      console.log(url, '=>', t.slice(0, 100));
    } catch (e) { console.log(url, '-> FAIL', e.message.slice(0, 50)); }
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 100)); process.exit(1); });
