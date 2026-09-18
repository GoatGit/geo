const { chromium } = require('playwright-core');
const url = process.argv[2];
(async () => {
  const browser = await chromium.connectOverCDP(url);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const cookies = await ctx.cookies('https://chat.deepseek.com');
  console.log('deepseek cookies:', cookies.map(c => c.name).join(',') || '(none)');
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto err', e.message));
  await page.waitForTimeout(3000);
  console.log('final url:', page.url());
  console.log('logined cookie check:', cookies.some(c => c.name === 'sessionid') ? 'sessionid present' : 'no sessionid');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
