const { chromium } = require('playwright-core');
const cdp = process.argv[2];
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto('https://ifconfig.me/ip', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    console.log('EGRESS_VIA_PROXY:', (await page.locator('body').innerText()).trim());
  } catch (e) {
    console.log('goto fail:', e.message.slice(0, 80));
    try {
      await page.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      console.log('baidu OK (代理失败但网络通)');
    } catch (e2) { console.log('baidu fail:', e2.message.slice(0, 60)); }
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 100)); process.exit(1); });
