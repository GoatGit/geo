/** 文心终极调试:手动点 switch-item,前后对比表单可见性。 */
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto('https://wenxin.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await page.getByText('请登录', { exact: true }).first().click().catch(() => undefined);
  await sleep(3500);
  const state = async (label) => {
    const s = await page.evaluate(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        return el ? !!(el.offsetParent || el.getClientRects().length) : null;
      };
      return { sms: vis('TANGRAM__PSP_11__smsPhone'), code: vis('TANGRAM__PSP_11__smsVerifyCode'), pwd: vis('TANGRAM__PSP_11__password'), tabCls: document.getElementById('TANGRAM__PSP_11__changeSmsCodeItem')?.className };
    });
    console.log(label, JSON.stringify(s));
  };
  await state('点击前:');
  // evaluate 直接 click
  await page.evaluate(() => document.getElementById('TANGRAM__PSP_11__changeSmsCodeItem')?.click());
  await sleep(1500);
  await state('evaluate click 后:');
  // playwright click
  await page.locator('#TANGRAM__PSP_11__changeSmsCodeItem').click({ force: true }).catch((e) => console.log('pw click err', e.message.slice(0, 60)));
  await sleep(1500);
  await state('pw force click 后:');
  await sleep(25000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
