/** 文心专用探索:等渲染+找弹窗内手机号元素。 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto('https://wenxin.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  // 点「请登录」/「登录」
  for (const t of ['请登录', '登录同步历史对话', '登录']) {
    const el = page.getByText(t, { exact: true }).first();
    if (await el.isVisible({ timeout: 500 }).catch(() => false)) { await el.click().catch(() => undefined); console.log('点击:', t); break; }
  }
  for (let round = 1; round <= 4; round++) {
    await sleep(3000);
    console.log(`\n== ${round * 3}s 后 ==`);
    console.log('frames:', page.frames().map((f) => f.url().slice(0, 80)));
    for (const f of page.frames()) {
      const texts = await f.locator('button, [role=button], [role=tab], a').allInnerTexts().catch(() => []);
      const hits = [...new Set(texts.map((t) => t.trim()).filter((t) => t && t.length <= 14))];
      if (hits.length) console.log(`[文本] ${f.url().slice(0, 45)}:`, JSON.stringify(hits.slice(0, 20)));
      const inputs = await f.locator('input:visible').all().catch(() => []);
      for (const inp of inputs.slice(0, 8)) {
        const m = await inp.evaluate((el) => ({ type: el.type, ph: el.placeholder, id: el.id })).catch(() => null);
        if (m) console.log(`[input] ${f.url().slice(0, 45)} type=${m.type} ph="${m.ph}" id=${m.id}`);
      }
    }
  }
  await sleep(30000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
