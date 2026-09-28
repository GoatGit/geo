import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto('https://chat.deepseek.com/sign_in', { timeout: 60000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const loc = page.locator('input[type=tel]').first();
const readVal = () => loc.evaluate(el => el.value);
await loc.click({ force: true });
await loc.pressSequentially('16292375937', { delay: 40 });
console.log('初填 A =', await readVal());
// 生产 typeIntoField 新逻辑:click → fill('') → Ctrl/Meta+A → Backspace → 逐字键入
await loc.click({ force: true }).catch(() => undefined);
await loc.fill('', { force: true }).catch(() => undefined);
await page.keyboard.press('ControlOrMeta+a').catch(() => undefined);
await page.keyboard.press('Backspace').catch(() => undefined);
await loc.pressSequentially('16292374681', { delay: 40 });
const v = await readVal();
console.log('重填 B =', v, v === '16292374681' ? '✅ 无拼接' : '❌ 拼接/残留');
await browser.close();
