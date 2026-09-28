// 本地探针:typeIntoField 重填清空逻辑实测——DeepSeek 真实手机号输入框,
// 先填号码 A,再用生产同款清空+重填逻辑填号码 B,断言最终值 === B(不拼接)。
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://chat.deepseek.com/sign_in', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5_000);

const loc = page.locator('input[type=tel]').first();
const readVal = () => loc.evaluate("el => el.value");
await loc.click({ force: true });
await loc.pressSequentially('16292375937', { delay: 40 });
console.log('初填 A =', await readVal());

// 生产 typeIntoField 同款重填逻辑(填 B)
await loc.click({ force: true }).catch(() => undefined);
await loc.evaluate("el => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); if (d && d.set) { d.set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); } else { el.value = ''; } }").catch(() => undefined);
await page.keyboard.press('ControlOrMeta+a').catch(() => undefined);
await page.keyboard.press('Backspace').catch(() => undefined);
await loc.pressSequentially('16292374681', { delay: 40 });
const finalVal = await readVal();
console.log('重填 B =', finalVal);
console.log(finalVal === '16292374681' ? '✅ 重填正确,无拼接' : '❌ 拼接/残留!');
await browser.close();
