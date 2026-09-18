const { chromium } = require('playwright-core');
const cdp = process.argv[2];
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  await ctx.addCookies([{ name: 'probe_test', value: 'injected_ok', domain: '.example.com', path: '/' }]);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto:', e.message.slice(0, 60)));
  await page.waitForTimeout(1000);
  const cookies = await ctx.cookies('https://example.com');
  const probe = cookies.find(c => c.name === 'probe_test');
  console.log('injection mechanics:', probe ? 'OK (cookie readable after navigation)' : 'FAILED');
  console.log('cookie value:', probe?.value);
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 100)); process.exit(1); });
