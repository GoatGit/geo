/** 元宝探索:登录弹窗切「手机」tab 后的表单。 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto('https://yuanbao.tencent.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  // 打开登录弹窗
  for (const t of ['登录', '请登录']) {
    const el = page.getByText(t, { exact: true }).first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) { await el.click().catch(() => undefined); console.log('点击:', t); break; }
  }
  await sleep(3000);
  // 切「手机」tab(radio 或文本)
  const phoneTab = page.getByText('手机', { exact: true }).first();
  if (await phoneTab.isVisible({ timeout: 800 }).catch(() => false)) { await phoneTab.click().catch(() => undefined); console.log('点击: 手机 tab'); }
  else {
    const radios = page.locator('input[type=radio]');
    const n = await radios.count().catch(() => 0);
    if (n >= 2) { await radios.nth(1).check({ force: true }).catch(() => undefined); console.log('点 radio#2'); }
  }
  await sleep(2500);
  for (const f of page.frames()) {
    const inputs = await f.locator('input:visible').all().catch(() => []);
    for (const inp of inputs) {
      const m = await inp.evaluate((el) => ({ type: el.type, ph: el.placeholder, id: el.id, name: el.name })).catch(() => null);
      if (m) console.log(`[input] ${f.url().slice(0, 40)} type=${m.type} ph="${m.ph}" id=${m.id}`);
    }
    const texts = await f.locator('button, [role=button], a').allInnerTexts().catch(() => []);
    const hits = [...new Set(texts.map((t) => t.trim()).filter((t) => t && t.length <= 14))];
    if (hits.length) console.log(`[文本] ${f.url().slice(0, 40)}:`, JSON.stringify(hits.slice(0, 18)));
  }
  console.log('保持 30 秒…');
  await sleep(30000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
