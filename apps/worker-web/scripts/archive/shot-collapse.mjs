import { chromium } from 'playwright-core';
const API = 'http://localhost:3000';
const r1 = await fetch(`${API}/auth/sms/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13800001234' }) }).then(r => r.json());
const r2 = await fetch(`${API}/auth/sms/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13800001234', code: r1.devCode }) }).then(r => r.json());
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(([t]) => { localStorage.setItem('geo.accessToken', t); localStorage.setItem('geo.brandId', '1'); }, [r2.accessToken]);
await page.goto('http://localhost:3001/dashboard', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/geo-shots/30-sidebar-expanded.png' });
// 点击收起按钮(顶栏左侧 header 内的收起按钮)
await page.locator('button[title="收起侧栏"]').click();
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/geo-shots/31-sidebar-collapsed.png' });
// 悬停展开(浮层)
await page.hover('aside');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/geo-shots/32-sidebar-hover.png' });
// 移开后回到图标栏,且刷新后状态持久
await page.mouse.move(800, 400);
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const width = await page.locator('aside').evaluate((el) => el.getBoundingClientRect().width);
console.log('刷新后侧栏宽度(应保持 68):', width);
await browser.close();
