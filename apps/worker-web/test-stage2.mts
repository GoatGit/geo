import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { siteConfigOf } from '@geo/engine-adapters';
const TOKEN = 'akm-ca8df948-74c6-4ac9-b2fd-2b5f77bbd129';
const rpc = (a: string, x: Record<string,string> = {}) => execFileSync('curl', ['-s','--max-time','180','-X','POST','-H','content-type: application/x-www-form-urlencoded','--data-binary', new URLSearchParams({Action:a,Version:'2025-05-06',Authorization:`Bearer ${TOKEN}`,RegionId:'cn-hangzhou',Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),SignatureNonce:randomUUID(),...x}).toString(), 'https://agentbay.cn-hangzhou.aliyuncs.com/']).toString();
const xml = (s: string, t: string) => s.match(new RegExp(`<${t}>(.*?)</${t}>`))?.[1] ?? null;
const sid = xml(rpc('CreateMcpSession', { ImageId: 'browser_latest' }), 'SessionId');
const cdp = xml(rpc('GetCdpLink', { SessionId: sid }), 'Url');
const browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
const page = (browser.contexts()[0] ?? (await browser.newContext())).pages()[0] ?? (await (browser.contexts()[0]!).newPage());
const site = siteConfigOf('doubao');
await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);
await page.locator('[contenteditable="true"]').first().click();
await page.keyboard.insertText('1+1等于几?');
await page.waitForTimeout(800);
const sel = 'button[class*="bg-dbx-fill-highlight"]';
const visible = await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false);
console.log('发送按钮可见:', visible, '| 数量:', await page.locator(sel).count());
if (visible) {
  await page.locator(sel).first().click({ force: true }).catch(async (e) => {
    console.log('常规点击失败, 试坐标点击:', String(e).slice(0, 80));
    const box = await page.locator(sel).first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
}
await page.waitForTimeout(10000);
console.log('URL:', page.url().slice(0, 80));
const text = await page.evaluate(() => document.body.innerText.slice(0, 250));
console.log('页面文本:', JSON.stringify(text.slice(0, 200)));
await page.screenshot({ path: '/tmp/db-stage2.png', timeout: 5000 }).catch(() => undefined);
await browser.close();
process.exit(0);
