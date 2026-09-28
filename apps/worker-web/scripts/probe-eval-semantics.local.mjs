import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto('https://chat.deepseek.com/sign_in', { timeout: 60000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const loc = page.locator('input[type=tel]').first();
console.log('A 字符串算式 1+1        =', await page.evaluate('1+1'));
console.log('B 字符串函数 el=>tagName =', await loc.evaluate('el => el.tagName').catch(e => 'ERR ' + e.message.split('\n')[0]));
console.log('C 真函数   el=>tagName   =', await loc.evaluate(el => el.tagName).catch(e => 'ERR ' + e.message.split('\n')[0]));
// 字符串函数体是否真的执行过:在 window 上留痕
await loc.evaluate('el => { window.__probeHit = 1; }').catch(() => {});
console.log('D 字符串函数体执行痕迹   =', await page.evaluate('window.__probeHit || 0'));
await loc.evaluate(el => { el.__probeHit2 = 1; }).catch(() => {});
console.log('E 真函数执行痕迹         =', await page.evaluate('window.__probeHit2 || 0'));
await browser.close();
