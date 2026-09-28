/**
 * 智能体登录技能·本地驱动端(不进生产镜像):
 *   pnpm exec tsx src/engine-login.ts --engine=deepseek --sms-link=<收码链接> --profile-id=21 [--manual] [--keep=60]
 *
 * 与生产采集同构:按档案的指纹/出口代理/AgentBay Context 直连远程浏览器(autoPhoneLogin
 * 机械流 + cmd.json 人工解验证码通道),登录成功后导出 Cookie/storageState 经 admin API
 * 回收入池(status available + 出口绑定,与 worker 登录成功写状态同一套字段)。
 * 环境变量取自 .env.debug(BROWSER_MODE=agentbay / AGENTBAY_* / GEO_ADMIN_PHONE)。
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
  const profileId = arg('profile-id');
  const apiBase = (arg('api', 'https://geo.gemux.cn') || 'https://geo.gemux.cn').replace(/\/$/, '');
  const manual = process.argv.includes('--manual');
  const keepMs = Number(arg('keep', '60')) * 1000;
  if (!smsLink || !profileId) {
    console.error('用法: tsx src/engine-login.ts --engine=deepseek --sms-link=<收码链接> --profile-id=<档案ID> [--manual] [--keep=60]');
    process.exit(1);
  }
  const site = siteConfigOf(engine);
  const token = smsTokenFromLink(smsLink);
  if (!token) {
    console.error('收码链接无法解析(缺 t= 参数)');
    process.exit(1);
  }

  // ── 1. 鉴权:优先 GEO_SKILL_API_KEY(管理后台全局配置生成的技能 Key),
  //      未配置时回落开发短信后门取 admin token ──────────────────────────────
  const skillKey = (process.env.GEO_SKILL_API_KEY ?? '').trim();
  let auth: Record<string, string>;
  if (skillKey) {
    auth = { 'x-api-key': skillKey, 'content-type': 'application/json' };
    console.log('[login] 鉴权:X-API-Key(GEO_SKILL_API_KEY)');
  } else {
    const adminPhone = process.env.GEO_ADMIN_PHONE ?? '13810497490';
    const codeResp = await fetch(`${apiBase}/api/auth/sms/code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: adminPhone }),
    }).then(r => r.json()) as { devCode?: string };
    if (!codeResp?.devCode) throw new Error(`获取 admin 登录码失败: ${JSON.stringify(codeResp)}`);
    const authResp = await fetch(`${apiBase}/api/auth/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: adminPhone, code: codeResp.devCode }),
    }).then(r => r.json()) as { accessToken?: string };
    if (!authResp?.accessToken) throw new Error('admin 登录失败');
    auth = { authorization: `Bearer ${authResp.accessToken}`, 'content-type': 'application/json' };
    console.log('[login] 鉴权:admin JWT(未配置 GEO_SKILL_API_KEY,建议在全局配置生成技能 Key)');
  }

  const ctx = await fetch(`${apiBase}/api/admin/accounts/${profileId}/login-context`, { headers: { authorization: auth.authorization } }).then(r => r.json()) as {
    id: number; engine: string; fingerprint: Record<string, unknown>; proxyServer: string | null; contextRef: string | null; status: string;
  };
  if (!ctx?.id) throw new Error(`读取档案登录上下文失败: ${JSON.stringify(ctx)}`);
  console.log(`[login] 档案 #${ctx.id} engine=${ctx.engine} status=${ctx.status} 出口=${ctx.proxyServer ?? '(直连)'} context=${ctx.contextRef?.slice(0, 20) ?? '无'}`);

  // ── 2. 远程浏览器会话(与生产采集同一 Context/出口/指纹)──────────────────────
  const dir = `/tmp/auto-login-debug/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  mkdirSync(dir, { recursive: true });
  const broker = createBrokerFromEnv();
  if ((process.env.BROWSER_MODE ?? 'mock') !== 'agentbay') {
    console.warn(`[login] 警告:BROWSER_MODE=${process.env.BROWSER_MODE ?? '(未设)'}——远程登录需 agentbay`);
  }
  const session = await broker.acquire({
    profileKey: `profile:${profileId}`,
    contextRef: ctx.contextRef ?? undefined,
    fingerprint: ctx.fingerprint,
    proxyHint: ctx.proxyServer ?? undefined,
    purpose: 'login',
  });
  console.log(`[login] AgentBay 会话已建立 context=${session.contextId?.slice(0, 20) ?? '无'}`);
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = await browser.newContext(browserContextOptions(ctx.fingerprint, ctx.proxyServer));
  const page = context.pages()[0] ?? (await context.newPage());
  console.log(`[login] 打开 ${site.chatUrl}`);
  await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  let seq = 0;
  const status = async (detail: string): Promise<void> => {
    console.log(`[status] ${new Date().toISOString().slice(11, 19)} ${detail}`);
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5_000 }).catch(() => null);
    if (buf) writeFileSync(`${dir}/snap-${String(++seq).padStart(3, '0')}.jpg`, buf);
  };

  // 实时帧(覆盖写)+ 命令文件通道:智能体对 live.jpg 观察后写 cmd.json 即注入远程页面
  // {"type":"click","x":..,"y":..} | {"type":"type","text":..} | {"type":"key","key":..} | {"type":"drag",fromX,fromY,toX,toY}
  const stop = { value: false };
  const frameLoop = (async () => {
    while (!stop.value) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5_000 }).catch(() => null);
      if (buf) writeFileSync(`${dir}/live.jpg`, buf);
      await page.waitForTimeout(2_000).catch(() => undefined);
    }
  })();
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
          await page.mouse.move(cmd.fromX, cmd.fromY ?? 0);
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

  // ── 3. 登录:自动机械流(autoPhoneLogin)+ 智能体人工解验证码;或 --manual 全手动 ──
  const sms = new SmsLinkClient(token);
  if (!manual) {
    // 免 db/redis 实例化:autoPhoneLogin 只依赖入参与模块级助手,不读实例状态
    const mgr = Object.create(LoginManager.prototype) as LoginManager;
    try {
      await mgr.autoPhoneLogin(page, site, sms, `skill-${Date.now()}`, status);
    } catch (err) {
      console.error(`[login] 自动机械流失败(可 --manual 人工接管): ${(err as Error).message.split('\n')[0]}`);
    }
  } else {
    console.log(`[login] 手动模式:智能体经 cmd.json 驱动登录,完成后 touch ${dir}/done.flag`);
    const doneFlag = `${dir}/done.flag`;
    for (let i = 0; i < 180 && !existsSync(doneFlag); i++) await page.waitForTimeout(5_000);
  }

  // ── 4. 校验登录态 → 导出凭证 → 回收入池 ─────────────────────────────────────
  const { loggedIn } = await checkLogin(page, site).catch(() => ({ loggedIn: false }));
  console.log(`[login] checkLogin=${JSON.stringify(loggedIn)} url=${page.url().slice(0, 80)}`);
  if (loggedIn !== true) {
    await status('登录态校验未通过,不入池;可排查后重跑');
    console.error('[login] 登录态校验未通过——不写入账号池');
    stop.value = true;
    await page.waitForTimeout(Math.min(keepMs, 15_000)).catch(() => undefined);
    await session.release();
    process.exit(1);
  }
  const storageState = await page.context().storageState();
  const ingest = await fetch(`${apiBase}/api/admin/accounts/${profileId}/credentials`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ storageState, contextId: session.contextId, proxyServer: ctx.proxyServer }),
  }).then(r => r.json()) as { ok?: boolean; cookies?: number; error?: string };
  if (!ingest?.ok) {
    console.error(`[login] 凭证入池失败: ${JSON.stringify(ingest)}`);
    process.exit(1);
  }
  console.log(`[login] ✅ 凭证已入池:档案 #${profileId} 置 available(cookies=${ingest.cookies}, 出口=${ctx.proxyServer ?? '直连'})`);
  await status(`登录成功,凭证已入池(cookies=${ingest.cookies})`);
  console.log(`[login] 保留画面 ${keepMs / 1000}s(Ctrl-C 提前退出)`);
  await page.waitForTimeout(keepMs).catch(() => undefined);
  stop.value = true;
  await session.release();
  process.exit(0);
}

main().catch((e) => {
  console.error('[login] 执行异常:', e instanceof Error ? e.message : e);
  process.exit(1);
});
