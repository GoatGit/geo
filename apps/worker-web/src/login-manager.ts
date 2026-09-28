import { and, eq } from 'drizzle-orm';
import type { Locator, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { Db } from '@geo/db';
import { accountProfiles } from '@geo/db';
import type { Redis } from 'ioredis';
import type { BrowserStorageState, EngineId } from '@geo/shared';
import {
  LOGIN_FRAME_TTL_SEC,
  LOGIN_REQ_QUEUE,
  LOGIN_STATUS_TTL_SEC,
  loginCancelKey,
  loginCmdKey,
  loginFrameKey,
  loginProfileKey,
  loginStatusKey,
  type LoginInputCommand,
  type LoginRequest,
  type LoginStatus,
} from '@geo/shared';
import { checkLogin, hasVisibleInput, loginBlockerVisible, siteConfigOf } from '@geo/engine-adapters';
import { browserModeFromEnv, viewerLoginFromEnv, type SessionBroker } from '@geo/browser-session';
import { ProxyPoolManager } from './qg-proxy';
import { SmsLinkClient, smsTokenFromLink } from './sms-client';
import { envInt } from './config';
import { browserContextOptions, verifyStoredLogin } from './browser-context';

/** 跨 frame 查找:豆包登录弹窗常是嵌入 iframe,page.locator 只扫主文档会找不到。 */
/** 原生渲染判定:百度登录弹窗(transform 缩放)会被 Playwright isVisible 误判不可见(实测)。 */
async function rendered(loc: Locator): Promise<boolean> {
  return loc.evaluate(el => !!(el.offsetParent || el.getClientRects().length)).catch(() => false);
}

/** 跨 frame 查找:遍历全部匹配取第一个原生渲染可见的——.first() 会命中同 selector 的隐藏元素
 *  (文心:placeholder*=手机 同时匹配账号 tab 用户名框与短信手机框,TANGRAM 实例号还会变)。 */
async function visibleAcrossFrames(page: Page, selector: string, timeoutMs = 1_000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      const all = frame.locator(selector);
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const loc = all.nth(i);
        if (await rendered(loc)) return loc;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(120).catch(() => undefined);
  }
}

/** 跨 frame 按文本/角色查找可点击元素(按钮/页签),同样用原生渲染判定。
 *  遍历全部匹配取首个渲染可见的:.first()+isVisible 在远程沙箱(transform 缩放/CDP 高延迟)
 *  会误判或 2s 内查不到 → 提交按钮静默跳过(DeepSeek 实测:码回填后停在登录页)。 */
async function clickableTextAcrossFrames(page: Page, text: string, timeoutMs = 1_000): Promise<Locator | null> {
  const re = new RegExp(text);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      for (const cand of [frame.getByRole('button', { name: re }), frame.getByText(re)]) {
        const n = await cand.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 6); i++) {
          const loc = cand.nth(i);
          if (await rendered(loc)) return loc;
        }
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(120).catch(() => undefined);
  }
}

/** React 受控输入:force 聚焦 + locator 级真实键盘(CDP)。
 *  重填(换号/补发重走)必须先真正清空:React 受控状态持旧值,直接补打会拼成双号
 *  (DeepSeek 实测「手机号码格式不正确」)。注意字符串形式的 locator.evaluate
 *  ('el => …')实测从不执行(playwright 不做元素绑定,静默返回 undefined),
 *  清空一律走 fill('')(内部原生 setter + input 事件),再全选退格兜底。 */
async function typeIntoField(page: Page, loc: Locator, value: string, delayMs = 60): Promise<void> {
  await loc.click({ force: true }).catch(() => undefined);
  await loc.fill('', { force: true }).catch(() => undefined);
  await page.keyboard.press('ControlOrMeta+a').catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
  await loc.pressSequentially(value, { delay: delayMs }).catch(async () => {
    await page.keyboard.type(value, { delay: delayMs });
  });
}

/** 引擎精确字段(本地逐引擎校准,0021):通用 placeholder 匹配会命中同弹窗其它 tab 的输入框。 */
const EXACT_LOGIN_FIELDS: Record<string, { phone: string; code: string }> = {
  wenxin: { phone: 'input[id*=smsPhone]', code: 'input[id*=smsVerifyCode]' },
  qwen: { phone: 'input[id*=fm-sms-login-id]', code: 'input[id*=fm-smscode]' },
};

/** 关闭登录页常见运营弹窗(下载客户端/领订阅等):右上角×、关闭/跳过文案,再补 Escape。 */
async function dismissPromos(page: Page): Promise<void> {
  const candidates = [
    page.locator('[class*="close" i]:visible'),
    page.locator('[aria-label*="关闭" i]:visible, [aria-label*="close" i]:visible'),
    page.getByText(/^(×|×|x|X|关闭|跳过|暂不下载|暂不使用|以后再说|暂不)$/),
  ];
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) {
      await c.nth(i).click({ timeout: 300 }).catch(() => undefined);
    }
  }
  await page.keyboard.press('Escape').catch(() => undefined);
}

/** 服务协议确认弹窗(元宝「服务协议及隐私保护」等):只有弹窗文案在场时才点「同意」,
 *  避免误点登录表单里同名的协议链接;点击后复核弹窗真的关闭(实测可能重弹/多实例),
 *  仍在场则再点;点掉后调用方需补一次发码(弹窗会拦住发送按钮)。 */
async function acceptAgreementDialog(page: Page): Promise<boolean> {
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let acted = false;
    for (const frame of page.frames()) {
      const gate = frame.getByText(/服务协议及隐私|服务协议和隐私|阅读并同意.*(用户服务协议|服务协议)/).first();
      if (!(await rendered(gate))) continue;
      for (const label of ['同意', '同意并继续', '接受并继续']) {
        const btn = frame.getByRole('button', { name: label }).first();
        if (await rendered(btn)) {
          await btn.click({ force: true, timeout: 2_000 }).catch(() => undefined);
          acted = true;
          break;
        }
        const txt = frame.getByText(label, { exact: true }).first();
        if (await rendered(txt)) {
          await txt.click({ force: true, timeout: 2_000 }).catch(() => undefined);
          acted = true;
          break;
        }
      }
      if (acted) break;
    }
    if (!acted) return clicked;
    clicked = true;
    await page.waitForTimeout(600); // 关闭动画;弹窗仍在场(重弹)则下一轮再点
  }
  return clicked;
}

/** 人机验证检测(图形/滑块/3D 点选):命中常见验证 iframe 或页面提示文案。 */
async function detectHumanCheck(page: Page): Promise<boolean> {
  if (await visibleAcrossFrames(page, 'iframe[src*=captcha], iframe[src*=verify], iframe[src*=geetest], iframe[src*=dingxiang], iframe[title*="验证"]', 300)) return true;
  for (const mark of ['拖动滑块', '拖动下方滑块', '安全验证', '图形验证', '完成拼图', '点击图中', '请点击']) {
    if (await clickableTextAcrossFrames(page, mark, 120)) return true;
  }
  return false;
}

/** 人工登录等待窗口:操作者扫码/验证码在此时间内完成,超时置 timeout 可重试。
 *  10 分钟起步:扫码后常要切换手机 App 再确认,窗口太短会"刚扫完就关"(可用 LOGIN_TIMEOUT_MS 覆盖)。 */
const LOGIN_TIMEOUT_MS = envInt('LOGIN_TIMEOUT_MS', 600_000, 30_000, 1_800_000);
/** viewer 模式截帧间隔(ms):登录操控 1-2fps 足够,降低远程浏览器压力。 */
const LOGIN_FRAME_MS = envInt('LOGIN_FRAME_MS', 700, 200, 5_000);
/** 登录并发上限:agentbay 每个登录独立云端沙箱可并行;受 API Key 并发与账号池容量约束。 */
const LOGIN_CONCURRENCY = envInt('LOGIN_CONCURRENCY', 3, 1, 10);

/**
 * 人工登录编排(worker 侧,docs/04 §3.1 账号生命周期):
 * 浏览器在 worker 进程侧(API 容器无浏览器),因此登录由 API 后台发请求、Worker 经
 * Redis 队列消费。两种操控形态:
 * - 本地弹窗(LOCAL_BROWSER_HEADED 且未开 viewer):操作者直接在弹出的窗口登录;
 * - 远程 viewer(生产 agentbay / LOGIN_VIEWER=1):worker 把远程页面截帧写 Redis、
 *   后台展示,操作者的点击/文字/回车指令经 Redis 回传,经 CDP 注入远程页面。
 * 成功则把档案置 available 并落 contextRef(登录态持久化),失败/超时写状态供后台展示。
 */
export class LoginManager {
  private readonly proxyPool: ProxyPoolManager;
  private stopped = false;
  private consumerRedis?: Redis;
  private loopTask?: Promise<void>;
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly broker: SessionBroker,
    proxyPool?: ProxyPoolManager,
  ) {
    // 代理池全进程单例(main 注入):登录与采集共用同一租约表,登录出口才能与采集出口对上
    this.proxyPool = proxyPool ?? new ProxyPoolManager(db, process.env.QG_PROXY_KEY ?? '');
  }

  start(): void {
    if (this.loopTask) return;
    // BLPOP must never block the connection used for frames, commands and status.
    this.consumerRedis = this.redis.duplicate();
    this.loopTask = this.loop();
    console.log(`[login] manager started: concurrency=${LOGIN_CONCURRENCY}, waiting for login requests`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.consumerRedis?.disconnect();
    await this.loopTask;
    await Promise.allSettled(this.active);
  }

  /**
   * 队列消费:并发上限内每个登录请求独立开远程会话(agentbay 每会话独立沙箱,
   * 并行不互扰);达到上限时轮询等待,任一登录结束即释放槽位。
   */
  private async loop(): Promise<void> {
    const active = this.active;
    while (!this.stopped) {
      if (active.size >= LOGIN_CONCURRENCY) {
        await Promise.race(active);
        continue;
      }
      try {
        const raw = await this.consumerRedis!.blpop(LOGIN_REQ_QUEUE, 2);
        if (!raw) continue;
        const req = JSON.parse(raw[1]!) as LoginRequest;
        if (await this.redis.get(loginProfileKey(req.profileId)) !== req.sessionId) continue;
        const task = this.run(req)
          .catch(async (err) => {
            console.error(`[login] session=${req.sessionId} engine=${req.engine} failed:`, err);
            await this.setStatus(req.sessionId, { state: 'error', detail: String(err), updatedAt: new Date().toISOString() });
          })
          .catch((err) => console.error('[login] failed to record terminal status:', (err as Error).message))
          .finally(async () => {
            try {
              await this.redis.eval(
                'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
                1, loginProfileKey(req.profileId), req.sessionId,
              );
            } catch (err) {
              console.error('[login] lock cleanup failed:', (err as Error).message);
            }
            active.delete(task);
          });
        active.add(task);
      } catch (err) {
        if (!this.stopped) {
          console.error('[login] loop error', err);
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    }
  }

  private async cancelled(sessionId: string): Promise<boolean> {
    return (await this.redis.get(loginCancelKey(sessionId))) === '1';
  }

  private async run(req: LoginRequest): Promise<void> {
    // 排队期间可能已被取消:取消的请求直接出队,不占用浏览器资源
    if (await this.cancelled(req.sessionId)) {
      await this.setStatus(req.sessionId, { state: 'cancelled', detail: '已手动取消', updatedAt: new Date().toISOString() });
      return;
    }
    if (browserModeFromEnv() === 'mock') {
      await this.setStatus(req.sessionId, {
        state: 'error',
        detail: 'BROWSER_MODE=mock 无真实浏览器;设为 local(本机 Chrome)或 agentbay 后再发起人工登录',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const site = siteConfigOf(req.engine as EngineId);
    const viewer = viewerLoginFromEnv();
    const startedAt = Date.now();
    await this.setStatus(req.sessionId, {
      state: 'running',
      detail: viewer ? '正在连接远程浏览器…(请在下方实时画面中操作登录)' : '正在打开浏览器…',
      viewer,
      updatedAt: new Date().toISOString(),
    });

    let cdpBrowser: import('playwright-core').Browser | null = null;
    // IP 亲和(采集事故复盘):重登时优先复用档案绑定的出口租约——同 IP 重新登录的
    // 通过率远高于换 IP;登录成功后把本次租约 server 写回档案,采集随之同源
    const profRow = (
      await this.db
        .select({ proxyServer: accountProfiles.proxyServer })
        .from(accountProfiles)
        .where(eq(accountProfiles.id, req.profileId))
        .limit(1)
    )[0];
    let loginLease: import('./qg-proxy').QgProxyLease | null = null;
    const session = await this.broker.acquire({
      profileKey: req.profileKey,
      contextRef: req.contextRef ?? undefined,
      fingerprint: req.fingerprint,
      proxyHint: req.proxyHint ?? undefined,
      purpose: 'login',
    });
    let releaseTask: Promise<void> | undefined;
    const releaseSession = () => releaseTask ??= (async () => {
      try {
        if (cdpBrowser) await cdpBrowser.close().catch(() => undefined);
      } finally {
        await session.release();
      }
    })();
    try {
      let page = session.page as Page | undefined;
      if (!page && /^wss?:\/\//.test(session.cdpUrl)) {
        cdpBrowser = await chromium.connectOverCDP(session.cdpUrl);
        // 登录会话走代理出口(与采集一致):Cookie 与出口 IP 绑定,
        // 之后采集经同一代理注入 Cookie,引擎才会认(docs/07 §13 闸门 #2)
        const { lease } = await this.proxyPool.acquireForProfile(profRow?.proxyServer ?? null);
        loginLease = lease;
        // 五引擎统一:登录 context 一律走代理出口(无租约时新建,不回退已存在的直连 context)——
        // AgentBay 直连豆包实测 30s 超时,登录态与出口 IP 必须绑定(docs/07 §13 闸门 #2)
        const context = req.engine === 'deepseek'
          ? await cdpBrowser.newContext(browserContextOptions(req.fingerprint, lease?.server ?? null))
          : await cdpBrowser.newContext(
              lease ? { proxy: { server: `http://${lease.server}` } } : {},
            );
        if (lease) console.log(`[login] session=${req.sessionId} 经代理 ${lease.server} 登录(出口 ${lease.egressIp})`);
        page = context.pages()[0] ?? (await context.newPage());
      }
      if (!page) throw new Error('broker 未提供可用页面');

      // 远程浏览器 + 代理链路慢:导航放宽到 90s,失败刷新一次再试
      let navigated = false;
      for (let nav = 0; nav < 2 && !navigated; nav++) {
        try {
          await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(site.navigationTimeoutMs, 90_000) });
          navigated = true;
        } catch (navErr) {
          console.warn(`[login] session=${req.sessionId} 导航失败(第 ${nav + 1} 次):${(navErr as Error).message.slice(0, 80)}`);
          if (nav === 1) throw navErr;
        }
      }
      console.log(`[login] session=${req.sessionId} engine=${req.engine} 浏览器已就绪(${site.displayName}),等待操作者登录…`);

      // viewer 模式:截帧 + 指令分发两个后台任务,随登录轮询一起跑
      const stopViewer = { value: false };
      const viewerTasks = viewer
        ? [this.frameLoop(req.sessionId, page, stopViewer), this.commandLoop(req.sessionId, page, stopViewer)]
        : [];

      // 收码链接自动登录(0019 豆包批量登录):smsLink 存在时系统自动完成
      // 取号 → 填手机号 → 发验证码 → 收码 → 回填,完成后由下方既有轮询验证并保存。
      // 任一步失败不阻断:状态说明原因,viewer/人工通道仍在,可接管完成。
      if (req.smsLink) {
        const token = smsTokenFromLink(req.smsLink);
        if (!token) {
          await this.setStatus(req.sessionId, {
            state: 'error',
            detail: '收码链接无法解析(缺少 t= 参数)',
            viewer, updatedAt: new Date().toISOString(),
          });
          await releaseSession();
          return;
        }
        const sms = new SmsLinkClient(token);
        try {
          await this.autoPhoneLogin(page, site, sms, req.sessionId, async detail => {
            await this.setStatus(req.sessionId, { state: 'running', detail, viewer, updatedAt: new Date().toISOString() });
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[login] session=${req.sessionId} 自动验证码登录失败:${msg}`);
          // 自动失败 = 立即以 error 结束会话:原因完整保留在状态行,不再回落被动等待
          await this.setStatus(req.sessionId, {
            state: 'error',
            detail: `自动验证码登录失败:${msg}`,
            viewer, updatedAt: new Date().toISOString(),
          });
          await releaseSession();
          return;
        }
      }

      try {
        // 轮询:正向登录凭证 + 提问框可见,连续两轮成立才算成功;
        // 操作者登录后若落在非会话页(如站点首页),周期性重导航回提问页再验证;
        // 每轮检查取消标记——手动取消立即终止并释放远程会话,不占后续登录队列
        let confirmStreak = 0;
        let lastNavAt = Date.now();
        let cancelled = false;
        let loginPromptOpened = false;
        let verifiedState: BrowserStorageState | undefined;
        let restoreHint = '';
        while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
          if (this.stopped || await this.cancelled(req.sessionId)) {
            cancelled = true;
            break;
          }
          await this.setStatus(req.sessionId, {
            state: 'running',
            detail: `${restoreHint}等待登录…(剩余 ${Math.ceil((LOGIN_TIMEOUT_MS - (Date.now() - startedAt)) / 1000)}s,请${viewer ? '在下方实时画面' : '在弹出的浏览器窗口'}中完成 ${site.displayName} 登录)`,
            viewer,
            updatedAt: new Date().toISOString(),
          });
          const { loggedIn } = await checkLogin(page, site);
          // 人工登录必须有正向凭证;游客可提问仅影响采集,不能让账号进入可用池。
          let usable = loggedIn === true && (await hasVisibleInput(page, site));
          // 初次进入时打开登录入口一次;后续操作由操作者控制,避免反复切换登录方式。
          if (!loginPromptOpened && !usable && site.loginHints.length > 0 && loggedIn !== true) {
            const dialogOpen = await page
              .getByText(/手机号登录|扫码登录|账号登录/)
              .first()
              .isVisible({ timeout: 300 })
              .catch(() => false);
            if (!dialogOpen) {
              for (const h of site.loginHints) {
                try {
                  const loc = page.locator(h).first();
                  if (await loc.isVisible({ timeout: 400 })) {
                    await loc.click({ timeout: 1_000 });
                    loginPromptOpened = true;
                    break;
                  }
                } catch { /* 下一个 */ }
              }
            }
          }
          // 二维码过期自动刷新(弹窗内「二维码失效」文本可点击刷新)
          try {
            const expired = page.getByText(/二维码(失效|过期)/).first();
            if (await expired.isVisible({ timeout: 300 }).catch(() => false)) {
              await expired.click({ timeout: 1_000 }).catch(() => undefined);
            }
          } catch { /* 无过期态 */ }
          // 图形验证/滑块可见时不强制导航——把操作者从验证页拽走正是元宝登录事故的根因
          const blocked = await loginBlockerVisible(page, site);
          if (loggedIn === true && !usable && !blocked && Date.now() - lastNavAt > 15_000) {
            // 登录成功但落在非会话页(如站点首页):带回提问页
            await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs }).catch(() => undefined);
            lastNavAt = Date.now();
            const recheck = await checkLogin(page, site);
            usable = recheck.loggedIn === true && (await hasVisibleInput(page, site));
          }
          if (blocked) confirmStreak = 0;
          confirmStreak = usable ? confirmStreak + 1 : 0;
          if (confirmStreak >= 2) {
            // 成功前硬校验:扫码后手机端确认未完成时,桌面端登录弹窗会先关闭,
            // "无登录UI + 输入框可见"会误判成功 → 会话被提前释放、窗口消失。
            // 校验 = 重新整页导航再验一轮:真登录的 Cookie 过导航仍在;误判则回到等待循环,
            // 窗口继续保留,操作者可在手机端完成确认后自然通过。
            await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs });
            await page.waitForTimeout(2_000);
            const verify = await checkLogin(page, site);
            const verifyUsable = verify.loggedIn === true && (await hasVisibleInput(page, site));
            if (verifyUsable) {
              if (req.engine !== 'deepseek') break;
              await this.setStatus(req.sessionId, {
                state: 'running', detail: '正在验证 DeepSeek 登录态能否在采集会话中恢复…', viewer,
                updatedAt: new Date().toISOString(),
              });
              const browser = cdpBrowser ?? page.context().browser();
              try {
                // Local persistent Chrome uses its installed UA; mirror that identity for the check.
                const fingerprint = cdpBrowser ? req.fingerprint : {
                  ...req.fingerprint,
                  ...await page.evaluate(() => ({ ua: navigator.userAgent, locale: navigator.language })),
                };
                const restored = browser && await verifyStoredLogin(
                  browser, site, fingerprint, loginLease?.server ?? null, await page.context().storageState(),
                );
                if (restored) { verifiedState = restored; break; }
                restoreHint = 'DeepSeek 未接受恢复的登录态,请在原窗口确认登录或重新登录。';
              } catch {
                restoreHint = 'DeepSeek 登录态恢复验证暂未完成,正在重试。';
              }
            }
            confirmStreak = 0;
          }
          await page.waitForTimeout(2_500);
        }

        if (cancelled) {
          console.warn(`[login] session=${req.sessionId} 手动取消,释放远程会话`);
        }
        cancelled = cancelled || this.stopped || await this.cancelled(req.sessionId);
        const success = !cancelled && confirmStreak >= 2;
        if (success) {
          // 保存 Cookie 与 localStorage,不能依赖远程 Context 同步;导出失败禁止入池。
          // 同时落出口绑定(IP 亲和):后续采集按本次租约复用同一出口
          const storageState = verifiedState ?? await page.context().storageState();
          const exported = storageState.cookies;
          // Finish browser persistence before exposing the profile to collectors.
          stopViewer.value = true;
          await Promise.allSettled(viewerTasks);
          await releaseSession();
          const updated = await this.db
            .update(accountProfiles)
            .set({
              status: 'available',
              contextRef: session.contextId ?? `local:${req.profileKey}`,
              cookies: exported,
              storageState,
              cooldownUntil: null,
              proxyServer: loginLease?.server ?? null,
            })
            .where(and(eq(accountProfiles.id, req.profileId), eq(accountProfiles.status, 'pending_login')))
            .returning({ id: accountProfiles.id });
          if (!updated.length) throw new Error('账号状态已改变,登录结果未写入;请刷新账号池');
          console.log(`[login] session=${req.sessionId} engine=${req.engine} 登录成功,档案 ${req.profileId} 置 available(cookies=${exported.length},origins=${storageState.origins.length},restoreVerified=${Boolean(verifiedState)}${loginLease ? `,出口=${loginLease.server}` : ''})`);
        } else if (!cancelled) {
          // 超时诊断:页面 URL + 当前 Cookie 名(校准各站登录 Cookie 标记)
          const cookieNames = await page
            .context()
            .cookies()
            .then((cs) => [...new Set(cs.map((c) => c.name))].slice(0, 30).join(','))
            .catch(() => '(读取失败)');
          console.warn(`[login] session=${req.sessionId} engine=${req.engine} 登录等待超时 url=${page.url().slice(0, 80)} cookies=[${cookieNames}]`);
        }
        const timeoutDetail = !cancelled && !success
          ? `等待超时:url=${page.url().slice(0, 60)},可重试`
          : undefined;
        await this.setStatus(req.sessionId, {
          state: cancelled ? 'cancelled' : success ? 'done' : 'timeout',
          detail: cancelled ? '已手动取消,远程会话已释放' : success ? '登录成功,账号已入可用池' : timeoutDetail,
          viewer,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        stopViewer.value = true;
        await Promise.allSettled(viewerTasks);
        await this.redis.del(loginFrameKey(req.sessionId), loginCmdKey(req.sessionId), loginCancelKey(req.sessionId));
      }
    } finally {
      await releaseSession();
    }
  }

  /**
   * 豆包手机号验证码自动登录(0019):收码站 API 取号 → 远程页填手机号并发送 →
   * start 收取 → 轮询验证码 → 回填提交。换号(replacing)自动重走;60 秒码效期内完成。
   * public:本地直连调试入口(debug-auto-login.ts)复用同一份实现,不依赖实例状态。
   */
  async autoPhoneLogin(page: Page, site: ReturnType<typeof siteConfigOf>, sms: SmsLinkClient, sessionId: string, status: (detail: string) => Promise<void>): Promise<void> {
    // 运营弹窗("下载豆包电脑版"等)只在打开登录入口前清扫——登录弹窗打开后
    // 不能再无差别清扫:弹窗右上角 × 会被误点,把登录框关掉(批量流程卡死根因)。
    await dismissPromos(page);
    // 服务协议弹窗(元宝实测)会盖住登录框,先点掉
    await acceptAgreementDialog(page);


    const loginDialogOpen = async (): Promise<boolean> => {
      // 弹窗打开标志(引擎通用):登录方式类文案或手机号输入框出现任一即算
      if (await phoneInputReady()) return true;
      for (const mark of ['扫码', '短信登录', '验证码登录', '微信\\n手机']) {
        if (await clickableTextAcrossFrames(page, mark, 300)) return true;
      }
      return false;
    };
    const openLoginDialog = async (): Promise<boolean> => {
      // 先精确文本「登录」(本地验证通过的方式),再回落 loginHints 选择器;
      // 每次点击后等弹窗真正出现(方法选择/扫码文案可见)
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const cand of [page.getByText('登录', { exact: true }).first(), ...site.loginHints.map(h => page.locator(h).first())]) {
          if (await cand.isVisible({ timeout: 400 }).catch(() => false)) {
            await cand.click({ timeout: 2_000 }).catch(() => undefined);
            for (let i = 0; i < 8; i++) {
              await page.waitForTimeout(400);
              if (await loginDialogOpen()) return true;
            }
          }
        }
      }
      return false;
    };

    const phoneInputReady = async (): Promise<boolean> => {
      // 文心 userName 的 placeholder 也含"手机",通用匹配会误判已就绪 → 精确字段优先
      return (await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 400)) !== null;
    };
    // 引擎 → 切到手机号登录视图需点的页签(本地 DOM 校准,0021):
    // deepseek /sign_in 直接是表单;qwen passport 直接呈现短信表单;doubao/wenxin/yuanbao 需切页签;
    // '[' 开头 = css 选择器(文心 switch-item 需 force 直点;TANGRAM 实例号会变,用子串匹配)
    const SMS_TABS: Record<string, string[]> = {
      doubao: ['手机号登录', '手机号', '验证码登录'],
      wenxin: ['[id*=changeSmsCodeItem]'],
      yuanbao: ['手机', '手机号登录'],
      qwen: [],
      deepseek: [],
    };
    const exactFields = EXACT_LOGIN_FIELDS[site.engine] ?? {};
    const openPhoneInput = async () => {
      if (await phoneInputReady()) return true;
      // 登录弹窗没开就先点开(deepseek 表单直出会跳过)
      await openLoginDialog();
      for (const retry of [1, 2]) {
        // 协议弹窗可能盖住页签/输入框(元宝实测),每轮重试前先点掉
        await acceptAgreementDialog(page);
        for (const tabText of SMS_TABS[site.engine] ?? ['手机号登录', '验证码登录']) {
          // css 选择器('[' 开头)走渲染查找 + force 直点(文心 switch-item 普通点击被遮挡);
          // 否则精确文本优先(页签常与相邻文案同容器,模糊匹配点到容器不触发)
          let tabLoc: Locator | null = null;
          let force = false;
          if (tabText.startsWith('[') || tabText.startsWith('#')) {
            tabLoc = await visibleAcrossFrames(page, tabText, 1_500);
            force = true;
          }
          if (!tabLoc) {
            for (const frame of page.frames()) {
              const exact = frame.getByText(tabText, { exact: true }).first();
              if (await rendered(exact)) { tabLoc = exact; break; }
            }
          }
          if (!tabLoc) tabLoc = await clickableTextAcrossFrames(page, tabText, 1_500);
          if (tabLoc) {
            await tabLoc.click(force ? { force: true } : { timeout: 2_000 }).catch(() => undefined);
            for (let i = 0; i < 45; i++) {
              await page.waitForTimeout(300);
              if (await phoneInputReady()) return true;
            }
          }
        }
        if (retry === 1) await openLoginDialog();
      }
      return false;
    };
    if (!(await openPhoneInput())) {
      // 现场诊断:失败时把各 frame URL 与页面可见文本摘要写进错误,后台状态行直接可读
      const frameUrls = page.frames().map(f => f.url().slice(0, 60)).join(' | ');
      const snippet = await page.evaluate("(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200))()").catch(() => '(读取失败)');
      throw new Error(`未能打开${site.displayName}手机号登录视图;frames=[${frameUrls}];页面文本:${snippet}`);
    }

    // 自动登录总预算(8 分钟):外层 LOGIN_TIMEOUT(10 分钟)需留出导航与登录确认时间。
    // 轮询超时不再直接报错——同一号码补发一次再收一轮(运营商丢包/发送被拦的兜底);
    // 收码站换号(replacing)后新号码重新获得补发机会。
    const autoDeadline = Date.now() + 480_000;
    const resentPhones = new Set<string>();
    const digits = (v: string) => v.replace(/\D/g, '');
    const stationFailed = async (st: { status: string; attempt?: number; max_attempts?: number }): Promise<boolean> => {
      if (st.status !== 'failed') return false;
      // 次数未用尽时站方会自动换号(实测 attempt 2→3 自轮换):等新号到手重走,
      // 而不是直接报错;次数用尽才是真死链接
      if ((st.attempt ?? 0) < (st.max_attempts ?? 1) && Date.now() < autoDeadline - 60_000) {
        await status(`收码站判定号码失败(${st.attempt ?? '?'}/${st.max_attempts ?? '?'}),等待站方换号后重取…`);
        await page.waitForTimeout(20_000);
        return true;
      }
      throw new Error(`收码站判定号码失败(次数已用尽 ${st.attempt ?? '?'}/${st.max_attempts ?? '?'}),请更换收码链接`);
    };
    // 回填验证码并提交:号码+验证码都重填(换号/抢救旧码时表单可能不一致);
    // 点后确认表单消失,没消失补点/回车兜底(生产实测:静默失败会停在回填后的页面)
    const submitCode = async (phone: string, code: string): Promise<void> => {
      await status(`验证码已收到(${code}),正在回填${site.displayName}…`);
      const phoneLoc = await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 3_000);
      if (phoneLoc) await typeIntoField(page, phoneLoc, phone, 60);
      const codeLoc = await visibleAcrossFrames(page, exactFields.code || 'input[placeholder*=验证码], input[autocomplete=one-time-code], input[type=number], input[maxlength="4"], input[maxlength="6"]', 3_000);
      if (codeLoc) {
        await typeIntoField(page, codeLoc, code, 80);
      } else {
        const anyInput = await visibleAcrossFrames(page, 'input', 2_000);
        if (anyInput) { await anyInput.click({ force: true }).catch(() => undefined); await page.keyboard.type(code, { delay: 120 }); }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const submit = await clickableTextAcrossFrames(page, '^登录$|^提交$|^确定$', 2_000);
        if (submit) await submit.click({ timeout: 2_000, force: true }).catch(() => undefined);
        let formGone = false;
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(500);
          if (!(await phoneInputReady())) { formGone = true; break; }
        }
        if (formGone) { await status('已提交登录,等待登录态确认…'); break; }
        if (attempt === 1) await page.keyboard.press('Enter').catch(() => undefined);
      }
    };
    for (let round = 1; round <= 6 && Date.now() < autoDeadline; round++) {
      if (!(await phoneInputReady()) && !(await openPhoneInput())) {
        const snippet = await page.evaluate("(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 150))()").catch(() => '(读取失败)');
        throw new Error(`登录视图丢失;页面文本:${snippet}`);
      }
      const session = await sms.getSession();
      if (await stationFailed(session)) { round--; continue; }
      // start 先行(发码之前):站方可能借 start 轮换号码(旧链接实测),以 start 返回的号
      // 为准填表,短信才会发进被监控的号——先发码后 start 会让短信进旧号作废(实测)
      const started = await sms.startCollect(session.slot ?? 0);
      if (await stationFailed(started)) { round--; continue; }
      const phone = [started.phone, session.phone].find(p => p && digits(p).length >= 11) ?? session.phone ?? started.phone ?? '';
      if (!phone) throw new Error('收码站未返回手机号');
      const slot = session.slot ?? 0;
      // 抢救已有验证码:上一轮发出、站方已收到的码(completed+code)在效期内直接回填,
      // 不再重发(实测:发码成功但流程误判换号时,码就躺在站里白白过期)
      if (started.status === 'completed' && started.code) {
        await submitCode(phone, started.code);
        const { loggedIn } = await checkLogin(page, site).catch(() => ({ loggedIn: false }));
        if (loggedIn === true) return;
        await status('站内已有验证码回填未通过(可能已过期),重新取号发送…');
        continue;
      }
      await status(`第 ${round} 轮:手机号 ${phone},正在填入${site.displayName}并发送验证码…`);

      await page.getByText(/暂不下载|以后再说|暂不使用/).first().click({ timeout: 300 }).catch(() => undefined);
      const phoneLoc = await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 3_000);
      if (!phoneLoc) throw new Error('手机号输入框未找到(可能被弹窗遮挡)');
      await typeIntoField(page, phoneLoc, phone, 60);
      // 协议勾选:优先标准 checkbox;豆包用自定义圆圈(非 input),按「已阅读并同意」文本左侧坐标点击
      const agreeInput = await visibleAcrossFrames(page, 'input[type=checkbox]', 400);
      if (agreeInput) {
        await agreeInput.check({ timeout: 1_000 }).catch(() => undefined);
      } else {
        const agreeText = await clickableTextAcrossFrames(page, '已阅读并同意', 500);
        if (agreeText) {
          const box = await agreeText.boundingBox().catch(() => null);
          if (box) await page.mouse.click(box.x - 14, box.y + box.height / 2).catch(() => undefined);
        }
      }
      // 发送验证码:文心按钮需 id 直点(文本匹配受容器影响);其余按引擎文案排序。
      // 重新发送/重新获取兜底:超时补发时按钮文案已从「获取验证码」变为「重新发送」
      const sendLabels = site.engine === 'doubao'
        ? ['下一步', '发送验证码', '获取验证码', '重新发送', '重新获取']
        : ['获取验证码', '发送验证码', '获取短信验证码', '重新发送', '重新获取', '下一步'];
      const clickSend = async (): Promise<boolean> => {
        if (site.engine === 'wenxin') {
          const btn = await visibleAcrossFrames(page, '[id*=smsTimer]', 2_000);
          if (btn) { await btn.click({ force: true }).catch(() => undefined); return true; }
        }
        for (const label of sendLabels) {
          const btn = await clickableTextAcrossFrames(page, label, 800);
          if (btn) { await btn.click({ timeout: 2_000, force: true }).catch(() => undefined); return true; }
        }
        return false;
      };
      if (!(await clickSend())) {
        // 倒计时态(码已在发送中/上一轮已点过):按钮文案是「X 秒后可再次获取」,
        // 没有可点的发送按钮——视作已发送,直接进入收码轮询
        let counting = false;
        for (const frame of page.frames()) {
          if (await rendered(frame.getByText(/秒后.{0,4}(获取|发送)|重新获取|重新发送/).first())) { counting = true; break; }
        }
        if (!counting) throw new Error(`${site.displayName}登录页未找到发送验证码按钮`);
      }
      // 元宝实测:发码瞬间弹「服务协议及隐私保护」拦住发送,点同意后补一次发送
      if (await acceptAgreementDialog(page)) await clickSend();

      // 收取并轮询验证码(start 已在轮首完成):窗口 5 分钟——画面弹图形/滑块验证码时
      // 操作者在 viewer 里人工处理(DeepSeek 实测人工解验证码远超 90 秒),心跳同步进度。
      let code: string | null = null;
      let rotated = false; // 收码站换号(replacing 或号码变化):旧号短信作废,立即换新号重走
      let captchaNoted = false;
      const POLL_MAX = 150; // 150 × 2s
      for (let poll = 0; poll < POLL_MAX && Date.now() < autoDeadline; poll++) {
        await page.waitForTimeout(2_000);
        const s = await sms.poll(slot).catch(() => null);
        if (s) {
          if (s.status === 'completed' && s.code) { code = s.code; break; }
          if (s.status === 'failed') break;
          // 号码被站方轮换(轮询响应的 phone 与所填号不一致)→ 本轮作废,马上重取号
          if (s.status === 'replacing' || (s.phone && digits(s.phone) !== digits(phone))) { rotated = true; break; }
        }
        // 每 20 秒检测一次人机验证并心跳;检测到则提示操作者在画面里手动完成
        if (poll > 0 && poll % 10 === 0) {
          const humanCheck = await detectHumanCheck(page);
          if (humanCheck && !captchaNoted) {
            captchaNoted = true;
            await status('检测到人机验证(图形/滑块),请在下方画面手动完成,完成后自动继续收取验证码…');
          } else {
            await status(`等待短信验证码(${poll * 2}s/${POLL_MAX * 2}s)${captchaNoted ? ',人机验证已处理' : ''}…`);
          }
        }
      }
      if (!code) {
        if (rotated) { await status('收码站已换号(旧号短信作废),用新号重走流程…'); continue; }
        // 同号补发:每个号码一次——重走一轮(重新填号/发码/轮询),发码按钮文案已含「重新发送」
        if (!resentPhones.has(phone) && Date.now() < autoDeadline - 60_000) {
          resentPhones.add(phone);
          await status(`验证码超时未收到,对 ${phone} 补发一次…`);
          round--;
          continue;
        }
        throw new Error(`超时未收到验证码${resentPhones.has(phone) ? '(已补发过一次)' : ''}${captchaNoted ? ',人机验证可能未完成,重试时请在画面中手动完成' : ''},请更换收码链接后重试`);
      }
      await submitCode(phone, code);
      return; // 之后由既有登录验证轮询确认并保存
    }
    throw new Error('自动登录预算用尽(多次换号/补发)仍未收到可用验证码,请更换收码链接后重试');
  }

  /** 截帧循环:远程页面 JPEG → Redis frame key(后台轮询展示)。 */
  private async frameLoop(sessionId: string, page: Page, stop: { value: boolean }): Promise<void> {
    while (!stop.value) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5_000, scale: 'css' });
        await this.redis.set(loginFrameKey(sessionId), buf.toString('base64'), 'EX', LOGIN_FRAME_TTL_SEC);
      } catch {
        // 单帧失败(页面跳转瞬间)不影响循环
      }
      await page.waitForTimeout(LOGIN_FRAME_MS).catch(() => undefined);
    }
  }

  /** 指令分发循环:后台的点击/文字/回车 → CDP 注入远程页面。 */
  private async commandLoop(sessionId: string, page: Page, stop: { value: boolean }): Promise<void> {
    const cmdKey = loginCmdKey(sessionId);
    while (!stop.value) {
      try {
        const raw = await this.redis.lpop(cmdKey);
        if (!raw) {
          await page.waitForTimeout(400).catch(() => undefined);
          continue;
        }
        const cmd = JSON.parse(raw) as LoginInputCommand;
        if (cmd.type === 'click') {
          await page.mouse.click(cmd.x, cmd.y);
        } else if (cmd.type === 'drag') {
          await page.mouse.move(cmd.x, cmd.y);
          await page.mouse.down();
          try {
            await page.mouse.move(cmd.toX, cmd.toY, { steps: 20 });
          } finally {
            await page.mouse.up();
          }
        } else if (cmd.type === 'scroll') {
          await page.mouse.wheel(0, cmd.deltaY);
        } else if (cmd.type === 'type') {
          await page.keyboard.insertText(cmd.text.slice(0, 200));
        } else if (cmd.type === 'key') {
          await page.keyboard.press(cmd.key === 'enter' ? 'Enter' : cmd.key);
        }
      } catch (err) {
        if (!stop.value) console.error('[login] command dispatch error:', (err as Error).message?.split('\n')[0]);
        await page.waitForTimeout(1_000).catch(() => undefined);
      }
    }
  }

  private async setStatus(sessionId: string, status: LoginStatus & { viewer?: boolean }): Promise<void> {
    await this.redis.set(loginStatusKey(sessionId), JSON.stringify(status), 'EX', LOGIN_STATUS_TTL_SEC);
  }
}
