/**
 * 本地直连远程 AgentBay 调试自动验证码登录(不进生产镜像):
 *   pnpm exec tsx src/debug-auto-login.ts --engine=deepseek --sms-link='https://sms.yangsea.top/?t=xxx' [--keep=60]
 *
 * 与生产共用同一份 LoginManager.autoPhoneLogin 实现(免 db/redis 实例化);
 * 状态行打点到控制台、每次状态变化存 snap-*.jpg、后台每 2s 刷新 live.jpg 供实时观察。
 * 环境变量取自 .env.debug(BROWSER_MODE=agentbay / AGENTBAY_*),脚本自动加载。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { createBrokerFromEnv } from '@geo/browser-session';
import { checkLogin, siteConfigOf } from '@geo/engine-adapters';
import type { EngineId } from '@geo/shared';
import { SmsLinkClient, smsTokenFromLink } from './sms-client';
import { browserContextOptions } from './browser-context';
import { LoginManager } from './login-manager';

const arg = (name: string, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

async function main() {
  // .env.debug 加载(不覆盖已有环境变量)
  const envPath = path.join(__dirname, '../.env.debug');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }

  const engine = arg('engine', 'deepseek') as EngineId;
  const smsLink = arg('sms-link');
  const keepMs = Number(arg('keep', '60')) * 1000;
  if (!smsLink) {
    console.error('用法: tsx src/debug-auto-login.ts --engine=deepseek --sms-link=<收码链接> [--keep=60]');
    process.exit(1);
  }
  const site = siteConfigOf(engine);
  const token = smsTokenFromLink(smsLink);
  if (!token) {
    console.error('收码链接无法解析(缺 t= 参数)');
    process.exit(1);
  }

  const dir = `/tmp/auto-login-debug/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  mkdirSync(dir, { recursive: true });
  console.log(`[debug] engine=${engine} 截图目录=${dir}`);

  const broker = createBrokerFromEnv();
  if ((process.env.BROWSER_MODE ?? 'mock') !== 'agentbay') {
    console.warn(`[debug] 警告:BROWSER_MODE=${process.env.BROWSER_MODE ?? '(未设)'}——直连远程调试需 agentbay`);
  }
  // 与 admin 建档案同款指纹;调试会话不复用 contextRef(每次全新环境,等价首次登录)
  const fingerprint = {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    viewport: '1366x850',
    locale: 'zh-CN',
  };

  const session = await broker.acquire({ profileKey: `debug-${engine}-${Date.now()}`, fingerprint, purpose: 'login' });
  console.log(`[debug] AgentBay 会话已建立 cdp=${session.cdpUrl.slice(0, 60)}…`);
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  // 生产登录 context 一律走代理;调试默认直连(DOM 交互与代理解耦),如需代理加 --proxy=<server>
  const proxyArg = arg('proxy') || null;
  const context = await browser.newContext(browserContextOptions(fingerprint, proxyArg));
  const page = context.pages()[0] ?? (await context.newPage());
  console.log(`[debug] 打开 ${site.chatUrl}`);
  await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  let seq = 0;
  const status = async (detail: string): Promise<void> => {
    console.log(`[status] ${new Date().toISOString().slice(11, 19)} ${detail}`);
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5_000 }).catch(() => null);
    if (buf) writeFileSync(`${dir}/snap-${String(++seq).padStart(3, '0')}.jpg`, buf);
  };

  // 实时帧(覆盖写),调试期间可反复查看最新画面
  const stop = { value: false };
  const frameLoop = (async () => {
    while (!stop.value) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5_000 }).catch(() => null);
      if (buf) writeFileSync(`${dir}/live.jpg`, buf);
      await page.waitForTimeout(2_000).catch(() => undefined);
    }
  })();

  // 命令文件通道:对 live.jpg 观察后,写 cmd.json 即注入远程页面(human-in-the-loop 调试)。
  // {"type":"click","x":790,"y":415} | {"type":"type","text":"433604"} | {"type":"key","key":"Enter"} | {"type":"drag","fromX":..,"fromY":..,"toX":..,"toY":..}
  let lastCmdMtime = 0;
  const cmdLoop = (async () => {
    const cmdPath = `${dir}/cmd.json`;
    while (!stop.value) {
      await page.waitForTimeout(500).catch(() => undefined);
      try {
        const st = existsSync(cmdPath) ? statSync(cmdPath) : null;
        if (!st || st.mtimeMs === lastCmdMtime) continue;
        lastCmdMtime = st.mtimeMs;
        const cmd = JSON.parse(readFileSync(cmdPath, 'utf8')) as { type: string; x?: number; y?: number; fromX?: number; fromY?: number; toX?: number; toY?: number; text?: string; key?: string };
        if (cmd.type === 'click' && cmd.x != null && cmd.y != null) {
          await page.mouse.click(cmd.x, cmd.y);
        } else if (cmd.type === 'drag' && cmd.fromX != null && cmd.toX != null) {
          await page.mouse.move(cmd.fromX, cmd.fromY ?? cmd.y ?? 0);
          await page.mouse.down();
          await page.mouse.move(cmd.toX, cmd.toY ?? cmd.fromY ?? 0, { steps: 25 });
          await page.mouse.up();
        } else if (cmd.type === 'type' && cmd.text) {
          await page.keyboard.insertText(cmd.text);
        } else if (cmd.type === 'key' && cmd.key) {
          await page.keyboard.press(cmd.key);
        } else {
          continue;
        }
        console.log(`[cmd] 已执行 ${JSON.stringify(cmd)}`);
      } catch { /* 文件不存在/半写状态,忽略 */ }
    }
  })();
  void cmdLoop;

  const sms = new SmsLinkClient(token);
  // 免 db/redis 实例化:autoPhoneLogin 只依赖入参与模块级助手,不读实例状态
  const mgr = Object.create(LoginManager.prototype) as LoginManager;
  const sessionId = `debug-${Date.now()}`;
  try {
    await mgr.autoPhoneLogin(page, site, sms, sessionId, status);
    console.log('[debug] autoPhoneLogin 正常返回');
  } catch (err) {
    console.error(`[debug] autoPhoneLogin 失败: ${(err as Error).message}`);
  }

  const { loggedIn } = await checkLogin(page, site).catch((e) => ({ loggedIn: `check 出错: ${(e as Error).message.slice(0, 80)}` }));
  console.log(`[debug] checkLogin=${JSON.stringify(loggedIn)} url=${page.url().slice(0, 80)}`);
  await status(`调试结束 loggedIn=${loggedIn}`);
  console.log(`[debug] 保留画面 ${keepMs / 1000}s(Ctrl-C 提前退出),live.jpg 持续刷新`);
  await page.waitForTimeout(keepMs).catch(() => undefined);
  stop.value = true;
  await frameLoop.catch(() => undefined);
  await session.release();
  process.exit(0);
}

main().catch((e) => {
  console.error('[debug] 执行异常:', e);
  process.exit(1);
});
