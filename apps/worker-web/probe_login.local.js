/** 本地探索:各引擎登录页 DOM 结构校准(只读探索,不真登录)。用法:node probe_login.local.js <engine> */
const { chromium } = require('playwright-core');
const engine = process.argv[2] || 'deepseek';
const URLS = {
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://qianwen.com/',
  wenxin: 'https://wenxin.baidu.com/',
  yuanbao: 'https://yuanbao.tencent.com/chat',
  doubao: 'https://www.doubao.com/chat/',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dump(page, label) {
  console.log(`\n===== ${label} =====`);
  console.log('frames:', page.frames().map((f) => f.url().slice(0, 70)));
  for (const f of page.frames()) {
    // 按钮和可点击文本
    const texts = await f.locator('button, [role=button], a[class*=login], [class*=login]').allInnerTexts().catch(() => []);
    const hits = [...new Set(texts.map((t) => t.trim()).filter((t) => t && t.length <= 16))];
    if (hits.length) console.log(`[文本] ${f.url().slice(0, 50)}:`, JSON.stringify(hits.slice(0, 30)));
    // 手机号/验证码输入框
    const inputs = await f.locator('input').all().catch(() => []);
    for (const inp of inputs.slice(0, 12)) {
      const m = await inp.evaluate((el) => ({ type: el.type, ph: el.placeholder, id: el.id, name: el.name, vis: !!(el.offsetParent || el.getClientRects().length) })).catch(() => null);
      if (m) console.log(`[input] ${f.url().slice(0, 50)} type=${m.type} ph="${m.ph}" id=${m.id} vis=${m.vis}`);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto(URLS[engine], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await dump(page, `${engine} 首页`);
  // 尝试点登录入口
  for (const label of ['登录', 'Sign in', 'Log in', '手机号登录']) {
    const btn = page.getByText(label, { exact: true }).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      console.log(`\n>>> 点击了「${label}」`);
      break;
    }
  }
  await sleep(2500);
  await dump(page, `${engine} 点登录后`);
  console.log('\n浏览器保持 45 秒,可手动继续探索登录弹窗…');
  await sleep(45000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
