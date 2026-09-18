import { and, eq } from 'drizzle-orm';
import type { Page } from 'playwright-core';
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
import { checkLogin, hasVisibleInput, siteConfigOf } from '@geo/engine-adapters';
import { browserModeFromEnv, viewerLoginFromEnv, type SessionBroker } from '@geo/browser-session';
import { ProxyPoolManager } from './qg-proxy';
import { envInt } from './config';
import { browserContextOptions, verifyStoredLogin } from './browser-context';

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
        const context = req.engine === 'deepseek'
          ? await cdpBrowser.newContext(browserContextOptions(req.fingerprint, lease?.server ?? null))
          : lease
            ? await cdpBrowser.newContext({ proxy: { server: `http://${lease.server}` } })
            : cdpBrowser.contexts()[0] ?? await cdpBrowser.newContext();
        if (lease) console.log(`[login] session=${req.sessionId} 经代理 ${lease.server} 登录(出口 ${lease.egressIp})`);
        page = context.pages()[0] ?? (await context.newPage());
      }
      if (!page) throw new Error('broker 未提供可用页面');

      await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs });
      console.log(`[login] session=${req.sessionId} engine=${req.engine} 浏览器已就绪(${site.displayName}),等待操作者登录…`);

      // viewer 模式:截帧 + 指令分发两个后台任务,随登录轮询一起跑
      const stopViewer = { value: false };
      const viewerTasks = viewer
        ? [this.frameLoop(req.sessionId, page, stopViewer), this.commandLoop(req.sessionId, page, stopViewer)]
        : [];

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
          if (loggedIn === true && !usable && Date.now() - lastNavAt > 15_000) {
            // 登录成功但落在非会话页(如站点首页):带回提问页
            await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs }).catch(() => undefined);
            lastNavAt = Date.now();
            const recheck = await checkLogin(page, site);
            usable = recheck.loggedIn === true && (await hasVisibleInput(page, site));
          }
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
                const fingerprint = cdpBrowser ? req.fingerprint : await page.evaluate(() => ({
                  ua: navigator.userAgent, locale: navigator.language, viewport: `${innerWidth}x${innerHeight}`,
                }));
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
