/** 文心页签专项:dump「短信登录」所在元素的可点击结构。 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto('https://wenxin.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await page.getByText('请登录', { exact: true }).first().click().catch(() => undefined);
  await sleep(3000);
  // 找含"短信登录"的所有元素,打印 tag/class
  const info = await page.evaluate(() => {
    const out = [];
    const walk = document.querySelectorAll('*');
    for (const el of walk) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      if (own.includes('短信登录')) {
        out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: own.slice(0, 20), id: el.id || '' });
      }
    }
    return out.slice(0, 6);
  });
  console.log('含「短信登录」自有文本的元素:', JSON.stringify(info, null, 1));
  await sleep(20000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
