const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const page = await browser.contexts()[0].newPage();
  for (const url of process.argv.slice(3)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({
      title: document.title?.slice(0, 60),
      og: document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.slice(0, 60) ?? null,
      body: document.body?.innerText?.slice(0, 80).replace(/\n/g, ' '),
      url: location.href.slice(0, 60),
    })).catch((e) => ({ err: e.message.slice(0, 50) }));
    console.log(url.slice(8, 50), '=>', JSON.stringify(r));
  }
  await browser.close();
})();
