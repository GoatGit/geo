import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { siteConfigOf } from '@geo/engine-adapters';

const TOKEN = process.env.AGENTBAY_API_TOKEN ?? (console.error('需要 AGENTBAY_API_TOKEN(node --env-file=.env.debug 运行)'), process.exit(1));
const rpc = (a: string, x: Record<string,string> = {}) => execFileSync('curl', ['-s','--max-time','180','-X','POST','-H','content-type: application/x-www-form-urlencoded','--data-binary', new URLSearchParams({Action:a,Version:'2025-05-06',Authorization:`Bearer ${TOKEN}`,RegionId:'cn-hangzhou',Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),SignatureNonce:randomUUID(),...x}).toString(), 'https://agentbay.cn-hangzhou.aliyuncs.com/']).toString();
const xml = (s: string, t: string) => s.match(new RegExp(`<${t}>(.*?)</${t}>`))?.[1] ?? null;
const shot = async (page: import('playwright-core').Page, name: string) => { await page.screenshot({ path: `/tmp/db-${name}.png`, timeout: 5000 }).catch(() => undefined); };

const sid = xml(rpc('CreateMcpSession', { ImageId: 'browser_latest' }), 'SessionId');
const cdp = xml(rpc('GetCdpLink', { SessionId: sid }), 'Url');
const browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
const site = siteConfigOf('doubao');
await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);
await shot(page, '1-loaded');

// 填输入框
let filled = false;
for (const sel of site.inputSelectors) {
  const loc = page.locator(sel).first();
  if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
    await loc.click().catch(() => undefined);
    await page.keyboard.insertText('1+1等于几?');
    filled = true;
    console.log('填入输入框:', sel);
    break;
  }
}
await shot(page, '2-filled');
if (!filled) { console.log('无可见输入框!'); await browser.close(); process.exit(1); }

// 点发送
let sent = false;
for (const sel of site.submitSelectors) {
  const loc = page.locator(sel).first();
  if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
    await loc.click().catch(() => undefined);
    sent = true;
    console.log('点击发送:', sel);
    break;
  }
}
if (!sent) { await page.keyboard.press('Enter'); console.log('回车兜底'); }
await page.waitForTimeout(8000);
await shot(page, '3-after-send');

// 检查是否有回答文本
for (const sel of site.answerSelectors) {
  const n = await page.locator(sel).count();
  if (n > 0) {
    const t = await page.locator(sel).last().innerText().catch(() => '');
    console.log(`回答容器 ${sel}: ${n} 个, 最后一个文本: ${t.slice(0, 100).replace(/\n/g, ' ')}`);
    break;
  }
}
await browser.close();
process.exit(0);
