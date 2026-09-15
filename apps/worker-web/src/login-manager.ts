import { eq } from 'drizzle-orm';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { Db } from '@geo/db';
import { accountProfiles } from '@geo/db';
import type { Redis } from 'ioredis';
import type { EngineId } from '@geo/shared';
import {
  LOGIN_FRAME_TTL_SEC,
  LOGIN_REQ_QUEUE,
  LOGIN_STATUS_TTL_SEC,
  loginCancelKey,
  loginCmdKey,
  loginFrameKey,
  loginStatusKey,
  type LoginInputCommand,
  type LoginRequest,
  type LoginStatus,
} from '@geo/shared';
import { checkLogin, hasVisibleInput, siteConfigOf } from '@geo/engine-adapters';
import { browserModeFromEnv, viewerLoginFromEnv, type SessionBroker } from '@geo/browser-session';
import { envInt } from './config';

/** 人工登录等待窗口:操作者扫码/验证码在此时间内完成,超时置 timeout 可重试。 */
const LOGIN_TIMEOUT_MS = envInt('LOGIN_TIMEOUT_MS', 300_000, 30_000, 1_800_000);
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
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly broker: SessionBroker,
  ) {}

  start(): void {
    void this.loop();
    console.log(`[login] manager started: concurrency=${LOGIN_CONCURRENCY}, waiting for login requests`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /**
   * 队列消费:并发上限内每个登录请求独立开远程会话(agentbay 每会话独立沙箱,
   * 并行不互扰);达到上限时轮询等待,任一登录结束即释放槽位。
   */
  private async loop(): Promise<void> {
    const active = new Set<Promise<void>>();
    while (!this.stopped) {
      if (active.size >= LOGIN_CONCURRENCY) {
        await Promise.race(active);
        continue;
      }
      try {
        const raw = await this.redis.blpop(LOGIN_REQ_QUEUE, 2);
        if (!raw) continue;
        const req = JSON.parse(raw[1]!) as LoginRequest;
        const task = this.run(req)
          .catch(async (err) => {
            console.error(`[login] session=${req.sessionId} engine=${req.engine} failed:`, err);
            await this.setStatus(req.sessionId, { state: 'error', detail: String(err), updatedAt: new Date().toISOString() });
          })
          .finally(() => active.delete(task));
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
    const session = await this.broker.acquire({
      profileKey: req.profileKey,
      contextRef: req.contextRef ?? undefined,
      fingerprint: req.fingerprint,
      proxyHint: req.proxyHint ?? undefined,
      purpose: 'login',
    });
    try {
      let page = session.page as Page | undefined;
      if (!page && /^wss?:\/\//.test(session.cdpUrl)) {
        cdpBrowser = await chromium.connectOverCDP(session.cdpUrl);
        const context = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
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
        // 轮询:未登录指示消失 + 提问框可见,连续两轮(间隔 5s)成立才算成功;
        // 操作者登录后若落在非会话页(如站点首页),周期性重导航回提问页再验证;
        // 每轮检查取消标记——手动取消立即终止并释放远程会话,不占后续登录队列
        let confirmStreak = 0;
        let lastNavAt = Date.now();
        let cancelled = false;
        while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
          if (await this.cancelled(req.sessionId)) {
            cancelled = true;
            break;
          }
          await this.setStatus(req.sessionId, {
            state: 'running',
            detail: `等待登录…(剩余 ${Math.ceil((LOGIN_TIMEOUT_MS - (Date.now() - startedAt)) / 1000)}s,请${viewer ? '在下方实时画面' : '在弹出的浏览器窗口'}中完成 ${site.displayName} 登录)`,
            viewer,
            updatedAt: new Date().toISOString(),
          });
          const { loggedIn } = await checkLogin(page, site);
          // 游客可输入的站点(元宝/文心)必须以登录 Cookie 为成功依据,
          // 否则游客输入框可见 + 关弹窗等动作会被误判为登录成功
          let usable =
            site.requireLoginCookie && loggedIn !== true
              ? false
              : loggedIn !== false && (await hasVisibleInput(page, site));
          if (!usable && Date.now() - lastNavAt > 15_000) {
            // 登录成功但落在非会话页(如站点首页):带回提问页
            await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs }).catch(() => undefined);
            lastNavAt = Date.now();
            const recheck = await checkLogin(page, site);
            usable =
              site.requireLoginCookie && recheck.loggedIn !== true
                ? false
                : recheck.loggedIn !== false && (await hasVisibleInput(page, site));
          }
          confirmStreak = usable ? confirmStreak + 1 : 0;
          if (confirmStreak >= 2) break;
          await page.waitForTimeout(5_000);
        }

        if (cancelled) {
          console.warn(`[login] session=${req.sessionId} 手动取消,释放远程会话`);
        }
        const success = !cancelled && confirmStreak >= 2;
        if (success) {
          await this.db
            .update(accountProfiles)
            .set({ status: 'available', contextRef: req.contextRef ?? `local:${req.profileKey}` })
            .where(eq(accountProfiles.id, req.profileId));
          console.log(`[login] session=${req.sessionId} engine=${req.engine} 登录成功,档案 ${req.profileId} 置 available`);
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
      await session.release(); // 登录会话立即干净退出:Cookie 刷盘后采集进程才能读到登录态
      if (cdpBrowser) await cdpBrowser.close().catch(() => undefined);
    }
  }

  /** 截帧循环:远程页面 JPEG → Redis frame key(后台轮询展示)。 */
  private async frameLoop(sessionId: string, page: Page, stop: { value: boolean }): Promise<void> {
    while (!stop.value) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5_000 });
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
