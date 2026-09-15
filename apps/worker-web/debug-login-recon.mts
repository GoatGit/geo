/**
 * 多引擎扫码登录并行调试器(不进生产镜像):
 *   pnpm exec tsx debug-login-recon.mts <engine> <port>
 * ① AgentBay 建独立会话 → 自动点开登录入口(doubao/qwen)
 * ② localhost:<port> 提供实时画面 + 点击/文字/回车注入
 * ③ 每 5s 打印登录判定与新增 Cookie(扫码成功的 Auth Cookie 名校准用)
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { ENGINE_SITES, siteConfigOf, checkLogin } from '@geo/engine-adapters';
import type { EngineId } from '@geo/shared';

const TOKEN = 'akm-ca8df948-74c6-4ac9-b2fd-2b5f77bbd129';
const REGION = 'cn-hangzhou';
const engine = (process.argv[2] ?? 'yuanbao') as EngineId;
const PORT = Number(process.argv[3] ?? 8791);
const site = siteConfigOf(engine);

function rpc(action: string, extra: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    Action: action, Version: '2025-05-06', Authorization: `Bearer ${TOKEN}`,
    RegionId: REGION, Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureNonce: randomUUID(), ...extra,
  };
  const body = new URLSearchParams(params).toString();
  return execFileSync('curl', ['-s', '--max-time', '180', '-X', 'POST',
    '-H', 'content-type: application/x-www-form-urlencoded', '--data-binary', body,
    `https://agentbay.${REGION}.aliyuncs.com/`]).toString();
}
const xml = (s: string, tag: string) => s.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1] ?? null;

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}][${engine}]`, ...a);

const create = rpc('CreateMcpSession', { ImageId: 'browser_latest' });
const sid = xml(create, 'SessionId');
if (!sid) { console.error('建会话失败:', create.slice(0, 300)); process.exit(1); }
const cdp = xml(rpc('GetCdpLink', { SessionId: sid }), 'Url');
log(`SessionId=${sid} 端口=${PORT}`);
log(`查看器: http://localhost:${PORT}`);

const browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);

/** 点开登录入口(按 loginHints 逐个尝试)。 */
async function openLoginUi(): Promise<string> {
  for (const hint of site.loginHints) {
    try {
      const loc = page.locator(hint).first();
      if (await loc.isVisible({ timeout: 600 })) { await loc.click(); return hint; }
    } catch { /* 下一个 */ }
  }
  return '';
}

const clicked = await openLoginUi();
log(clicked ? `已自动点击登录入口(${clicked}),二维码应已弹出` : '未自动点开登录入口,请在画面中手动点击');

let frame: Buffer | null = null;
let vw = 1920, vh = 992;
try {
  const dim = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  vw = dim.w; vh = dim.h;
} catch {}
log(`真实视口: ${vw}x${vh}`);

// 截帧循环
(async () => {
  while (true) {
    try { frame = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }); } catch {}
    await page.waitForTimeout(700).catch(() => undefined);
  }
})();

// 判定/Cookie 诊断循环:仅在变化时打印
const startCookies = new Set((await page.context().cookies()).map((c) => c.name));
let known = new Set<string>(startCookies);
(async () => {
  while (true) {
    try {
      const { loggedIn, hint } = await checkLogin(page, site);
      const now = new Set((await page.context().cookies()).map((c) => c.name));
      const fresh = [...now].filter((n) => !known.has(n));
      const input = site.inputSelectors.some((sel) => {
        try { return page.locator(sel).first().isVisible({ timeout: 300 }); } catch { return false; }
      });
      if (fresh.length) {
        log(`★新增Cookie:[${fresh.join(',')}] → 全部Cookie:[${[...now].join(',')}]`);
        known = now;
      }
      // 二维码过期自动刷新 + 协议自动勾选
      try {
        const expired = page.getByText(/二维码(失效|过期)/).first();
        if (await expired.isVisible({ timeout: 300 })) { await expired.click(); log('↻ 检测到二维码过期,已自动点击刷新'); }
      } catch { /* 无过期态 */ }
      try {
        const cb = page.locator('input[type="checkbox"]').first();
        if (await cb.isVisible({ timeout: 200 })) {
          const checked = await cb.isChecked().catch(() => true);
          if (!checked) { await cb.click().catch(() => undefined); log('☑ 已自动勾选用户协议'); }
        }
      } catch { /* 无勾选框 */ }
      log(`loggedIn=${JSON.stringify(loggedIn)}${hint ? ` (${hint})` : ''} input=${input} url=${page.url().slice(0, 70)}`);
    } catch (e) { log('诊断循环错误:', String(e).slice(0, 80)); }
    await page.waitForTimeout(5_000).catch(() => undefined);
  }
})();

// 本地操控服务
const HTML = `<!doctype html><meta charset=utf-8><title>调试:${site.displayName}</title>
<body style="margin:0;background:#111;color:#eee;font-family:system-ui">
<div style="padding:6px 12px">调试查看器:${site.displayName}(${engine}) — 扫码登录本页面</div>
<img id=shot src="/frame.jpg" style="width:100vw;display:block" />
<div style="display:flex;gap:8px;padding:8px;position:sticky;bottom:0;background:#222">
<input id=txt placeholder="发送文字到已聚焦输入框" style="flex:1;padding:8px">
<button onclick="fetch('/relogin')">重开登录框</button><button onclick="sendText()">发送文字</button>
<button onclick="key('Enter')">回车</button><button onclick="key('Backspace')">退格</button></div>
<script>
const img = document.getElementById('shot');
setInterval(() => { img.src = '/frame.jpg?t=' + Date.now(); }, 1000);
img.onclick = (e) => {
  const r = img.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) / r.width * ${vw});
  const y = Math.round((e.clientY - r.top) / r.height * ${vh});
  fetch('/click?x=' + x + '&y=' + y);
};
const sendText = () => { fetch('/text?t=' + encodeURIComponent(document.getElementById('txt').value)); document.getElementById('txt').value = ''; };
const key = (k) => fetch('/key?k=' + k);
</script>`;

http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/frame.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(frame ?? Buffer.alloc(0));
  } else if (u.pathname === '/click') {
    void page.mouse.click(Number(u.searchParams.get('x')), Number(u.searchParams.get('y'))).catch(() => undefined);
    res.writeHead(204); res.end();
  } else if (u.pathname === '/text') {
    void page.keyboard.insertText((u.searchParams.get('t') ?? '').slice(0, 200)).catch(() => undefined);
    res.writeHead(204); res.end();
  } else if (u.pathname === '/key') {
    const k = u.searchParams.get('k') ?? 'Enter';
    void page.keyboard.press(k === 'enter' ? 'Enter' : k).catch(() => undefined);
    res.writeHead(204); res.end();
  } else if (u.pathname === '/relogin') {
    void openLoginUi().then((h) => log('重开登录框:', h || '未找到入口'));
    res.writeHead(204); res.end();
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
  }
}).listen(PORT, () => log(`操控服务: http://localhost:${PORT}`));
