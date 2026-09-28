/** 文心探索2:切到验证码登录,看表单与图片验证码。 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto('https://wenxin.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await page.getByText('请登录', { exact: true }).first().click().catch(() => undefined);
  await sleep(3000);
  // 尝试切验证码登录
  for (const t of ['短信登录', '切换登录方式', '验证码登录']) {
    const el = page.getByText(t, { exact: false }).first();
    if (await el.isVisible({ timeout: 500 }).catch(() => false)) { await el.click().catch(() => undefined); console.log('点击:', t); break; }
  }
  await sleep(2500);
  for (const f of page.frames()) {
    const inputs = await f.locator('input:visible').all().catch(() => []);
    for (const inp of inputs) {
      const m = await inp.evaluate((el) => ({ type: el.type, ph: el.placeholder, id: el.id })).catch(() => null);
      if (m) console.log(`[input] ${f.url().slice(0, 40)} type=${m.type} ph="${m.ph}" id=${m.id}`);
    }
    const texts = await f.locator('button, [role=button], a, span[class*=btn], p[class*=tab], div[class*=tab]').allInnerTexts().catch(() => []);
    const hits = [...new Set(texts.map((t) => t.trim()).filter((t) => t && t.length <= 14))];
    if (hits.length) console.log(`[文本] ${f.url().slice(0, 40)}:`, JSON.stringify(hits.slice(0, 18)));
    const imgs = await f.locator('img:visible').all().catch(() => []);
    for (const img of imgs.slice(0, 6)) {
      const src = await img.getAttribute('src').catch(() => null);
      const w = await img.evaluate((el) => el.width).catch(() => 0);
      if (src && w > 60 && w < 200) console.log(`[img-可能图形验证码] ${src.slice(0, 70)} w=${w}`);
    }
  }
  console.log('保持 30 秒供检查…');
  await sleep(30000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
