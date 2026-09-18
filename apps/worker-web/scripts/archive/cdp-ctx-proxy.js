const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP(process.argv[2]);
  // context 级代理:CDP 下由 Playwright 管理的 context 是否支持 proxy
  const ctx = await browser.newContext({ proxy: { server: 'http://125.124.106.64:18080' } });
  const page = await ctx.newPage();
  try {
    await page.goto('https://ifconfig.me/ip', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    console.log('CTX_PROXY_EGRESS:', (await page.locator('body').innerText()).trim());
  } catch (e) { console.log('ctx proxy fail:', e.message.slice(0, 90)); }
  await ctx.close(); await browser.close();
})().catch(e => console.error('FATAL', e.message.slice(0, 90)));