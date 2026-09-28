// 本地探针 3:DeepSeek 登录按钮 DOM 实测——现有 clickableTextAcrossFrames 查询能否命中、
// 点击后 UI 是否有反应(假码会弹错误 toast = 点击机制通)。
import { chromium } from 'playwright-core';

const rendered = (loc) => loc.evaluate((el) => !!(el.offsetParent || el.getClientRects().length)).catch(() => false);

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://chat.deepseek.com/sign_in', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5_000);

// 1) 全量 dump 页面 button
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button, [role=button]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 20),
      visible: !!(el.offsetParent || el.getClientRects().length),
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
    };
  }),
).catch((e) => ['dump失败: ' + e.message]);
console.log('页面 button 清单:', JSON.stringify(buttons, null, 1));

// 2) 现有查询逻辑:^登录$ byRole .first() + isVisible
const re = new RegExp('^登录$|^提交$|^确定$');
const byRole = page.getByRole('button', { name: re }).first();
console.log('现有逻辑 byRole.isVisible =', await byRole.isVisible().catch((e) => 'ERR ' + e.message.split('\n')[0]));
const byText = page.getByText('^登录$|^提交$|^确定$', { exact: false }).first();
console.log('现有逻辑 byText(字符串当正则源,恒不匹配).isVisible =', await byText.isVisible().catch(() => false));

// 3) 拟改逻辑:遍历全部匹配 + 原生渲染判定
let found = null;
for (const cand of [page.getByRole('button', { name: re }), page.getByText(re)]) {
  const n = await cand.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 6); i++) {
    const loc = cand.nth(i);
    if (await rendered(loc)) { found = loc; break; }
  }
  if (found) break;
}
console.log('拟改逻辑命中:', Boolean(found));

// 4) 填假码 → 点登录 → 看是否有反应(toast/表单变化 = 点击机制通)
const phone = page.locator('input[type=tel]').first();
if (await phone.isVisible().catch(() => false)) {
  await phone.click();
  await phone.pressSequentially('16292376584', { delay: 40 });
}
const codeInput = page.locator('input[placeholder*=验证码], input[maxlength="6"]').first();
if (await codeInput.isVisible().catch(() => false)) {
  await codeInput.click();
  await codeInput.pressSequentially('433604', { delay: 60 });
  await page.waitForTimeout(500);
}
if (found) {
  await found.click({ force: true, timeout: 2_000 }).catch((e) => console.log('点击异常:', e.message?.split('\n')[0]));
  await page.waitForTimeout(2_500);
  const toast = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
  console.log('点击后页面文本:', toast);
  await page.screenshot({ path: '/tmp/probe-ds-submit.png' });
}
await page.waitForTimeout(1_500);
await browser.close();
