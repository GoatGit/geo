/**
 * 本地登录调试查看器(不进生产镜像):
 *   pnpm exec tsx debug-viewer.mts <doubao|yuanbao|wenxin|deepseek|qwen>
 * ① 用 AK 直连 AgentBay 建会话(cn-hangzhou)
 * ② 本地起 http://localhost:8787:页面展示远程截帧,点击/文字/回车经 CDP 注入
 * ③ 每 5s 打印 checkLogin 判定 + Cookie 名变化(校准 loggedInCookieHints 用)
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { siteConfigOf, checkLogin } from '@geo/engine-adapters';
import type { EngineId } from '@geo/shared';

const TOKEN = process.env.AGENTBAY_API_TOKEN ?? (console.error('需要 AGENTBAY_API_TOKEN(node --env-file=.env.debug 运行)'), process.exit(1));
const REGION = 'cn-hangzhou';
const engine = (process.argv[2] ?? 'yuanbao') as EngineId;
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

const create = rpc('CreateMcpSession', { ImageId: 'browser_latest' });
const sid = xml(create, 'SessionId');
if (!sid) { console.error('建会话失败:', create.slice(0, 300)); process.exit(1); }
const cdp = xml(rpc('GetCdpLink', { SessionId: sid }), 'Url');
console.log(`[${engine}] SessionId: ${sid}\nCDP: ${cdp}`);

const browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2000);

let frame: Buffer | null = null;
let vw = 1280, vh = 800;
try { const vp = page.viewportSize(); if (vp) { vw = vp.width; vh = vp.height; } } catch {}
console.log(`viewport: ${vw}x${vh}`);

// 截帧循环(700ms)
(async () => {
  while (true) {
    try { frame = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }); } catch {}
    await page.waitForTimeout(700).catch(() => undefined);
  }
})();

// 判定/诊断循环(5s)
(async () => {
  const startCookies = new Set((await page.context().cookies()).map((c) => c.name));
  console.log(`初始 cookies: [${[...startCookies].join(',')}]`);
  while (true) {
    try {
      const { loggedIn, hint } = await checkLogin(page, site);
      const now = new Set((await page.context().cookies()).map((c) => c.name));
      const newCookies = [...now].filter((n) => !startCookies.has(n));
      const input = site.inputSelectors.some((sel) => {
        try { return page.locator(sel).first().isVisible({ timeout: 300 }); } catch { return false; }
      });
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] loggedIn=${JSON.stringify(loggedIn)}` +
        `${hint ? ` (${hint})` : ''} input=${input} url=${page.url().slice(0, 70)}` +
        (newCookies.length ? ` ★新Cookie:[${newCookies.join(',')}]` : ''),
      );
    } catch (e) { console.log('判定循环错误:', String(e).slice(0, 80)); }
    await page.waitForTimeout(5_000).catch(() => undefined);
  }
})();

// 本地操控服务
const HTML = `<!doctype html><meta charset=utf-8><title>调试查看器 - ${site.displayName}</title>
<body style="margin:0;background:#111;color:#eee;font-family:system-ui">
<div style="padding:8px 12px">调试查看器:${site.displayName}(点击画面=远程鼠标)</div>
<img id=shot src="/frame.jpg" style="width:100vw;display:block" />
<div style="display:flex;gap:8px;padding:8px;position:sticky;bottom:0;background:#222">
<input id=txt placeholder="输入文字(发送到已聚焦输入框)" style="flex:1;padding:8px">
<button onclick="sendText()">发送文字</button><button onclick="key('Enter')">回车</button>
<button onclick="key('Backspace')">退格</button></div>
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
    const x = Number(u.searchParams.get('x')), y = Number(u.searchParams.get('y'));
    void page.mouse.click(x, y).catch(() => undefined);
    res.writeHead(204); res.end();
  } else if (u.pathname === '/text') {
    void page.keyboard.insertText((u.searchParams.get('t') ?? '').slice(0, 200)).catch(() => undefined);
    res.writeHead(204); res.end();
  } else if (u.pathname === '/key') {
    const k = u.searchParams.get('k') ?? 'Enter';
    void page.keyboard.press(k === 'enter' ? 'Enter' : k).catch(() => undefined);
    res.writeHead(204); res.end();
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
  }
}).listen(8787, () => console.log('查看器: http://localhost:8787'));
