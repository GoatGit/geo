/**
 * 视觉自查工具:用系统 Chrome 无头对官网/登录/控制台全部页面截图到 /tmp/geo-shots/。
 * 用法:先启动 API(:3000)与 Web(:3001),然后在 apps/worker-web 下执行:
 *   node ../../scripts/screenshot-pages.mjs
 * 依赖 playwright-core(worker-web 已有)+ 本机 Chrome。
 */
import { chromium } from 'playwright-core';

const API = process.env.API_ORIGIN ?? 'http://localhost:3000';
const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:3001';
const OUT = process.env.SHOT_DIR ?? '/tmp/geo-shots';

async function login() {
  const r1 = await fetch(`${API}/auth/sms/code`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: process.env.PHONE ?? '13800001234' }),
  }).then((r) => r.json());
  const r2 = await fetch(`${API}/auth/sms/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: process.env.PHONE ?? '13800001234', code: r1.devCode }),
  }).then((r) => r.json());
  return r2;
}

const { accessToken } = await login();
console.log('token ok');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(
  ([t, brandId]) => {
    localStorage.setItem('geo.accessToken', t);
    localStorage.setItem('geo.brandId', String(brandId));
  },
  [accessToken, process.env.BRAND_ID ?? 1],
);

const pages = [
  ['landing', '/', false],
  ['login', '/login', false],
  ['dashboard', '/dashboard', true],
  ['rankings', '/monitor/rankings', true],
  ['competitors', '/monitor/competitors', true],
  ['citations', '/monitor/citations', true],
  ['reputation', '/reputation', true],
  ['questions', '/config/questions', true],
  ['recognition', '/config/recognition', true],
  ['collection', '/config/collection', true],
  ['reports', '/reports', true],
  ['brand-new', '/brands/new', true],
];
for (const [name, path, full] of pages) {
  await page.goto(WEB + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('shot', name);
}
await browser.close();
console.log('DONE →', OUT);
