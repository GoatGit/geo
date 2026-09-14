import { chromium } from 'playwright-core';
const API = 'http://localhost:3000';
const r1 = await fetch(`${API}/auth/sms/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13800001234' }) }).then(r => r.json());
const r2 = await fetch(`${API}/auth/sms/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13800001234', code: r1.devCode }) }).then(r => r.json());
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(([t]) => { localStorage.setItem('geo.accessToken', t); localStorage.setItem('geo.brandId', '1'); }, [r2.accessToken]);
await page.goto('http://localhost:3001/dashboard', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const info = await page.evaluate(async () => {
  const t = localStorage.getItem('geo.accessToken');
  const r = await fetch('/api/monitor/rankings?brand=1&days=1', { headers: { authorization: `Bearer ${t}` } });
  const j = await r.json();
  return { trend: j.trend, svgCount: document.querySelectorAll('.card svg').length, cardCount: document.querySelectorAll('.card').length };
});
console.log(JSON.stringify(info, null, 1).slice(0, 500));
await browser.close();
