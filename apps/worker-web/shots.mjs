import { chromium } from 'playwright-core';

const API = 'http://localhost:3000';
const WEB = 'http://localhost:3001';
const OUT = '/tmp/geo-shots';

async function login() {
  const r1 = await fetch(`${API}/auth/sms/code`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800001234' }),
  }).then((r) => r.json());
  const r2 = await fetch(`${API}/auth/sms/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800001234', code: r1.devCode }),
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
  [accessToken, 1],
);

for (const [name, path] of [['landing', '/'], ['login', '/login']]) {
  await page.goto(WEB + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/01-${name}.png`, fullPage: name === 'landing' });
  console.log('shot', name);
}

const consolePages = [
  ['dashboard', '/dashboard'],
  ['rankings', '/monitor/rankings'],
  ['competitors', '/monitor/competitors'],
  ['citations', '/monitor/citations'],
  ['reputation', '/reputation'],
  ['questions', '/config/questions'],
  ['recognition', '/config/recognition'],
  ['collection', '/config/collection'],
  ['reports', '/reports'],
  ['brand-new', '/brands/new'],
];
for (const [name, path] of consolePages) {
  await page.goto(WEB + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/10-${name}.png`, fullPage: true });
  console.log('shot', name);
}

await browser.close();
console.log('DONE');
