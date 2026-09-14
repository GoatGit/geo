import { eq } from 'drizzle-orm';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { Db } from '@geo/db';
import { accountProfiles } from '@geo/db';
import type { Redis } from 'ioredis';
import type { EngineId } from '@geo/shared';
import {
  LOGIN_REQ_QUEUE,
  LOGIN_STATUS_TTL_SEC,
  loginStatusKey,
  type LoginRequest,
  type LoginStatus,
} from '@geo/shared';
import { checkLogin, hasVisibleInput, siteConfigOf } from '@geo/engine-adapters';
import { browserModeFromEnv, type SessionBroker } from '@geo/browser-session';
import { envInt } from './config';

/** 人工登录等待窗口:操作者扫码/验证码在此时间内完成,超时置 timeout 可重试。 */
const LOGIN_TIMEOUT_MS = envInt('LOGIN_TIMEOUT_MS', 300_000, 30_000, 1_800_000);

/**
 * 人工登录编排(worker 侧,docs/04 §3.1 账号生命周期):
 * 浏览器在 worker 进程侧(API 容器无浏览器),因此登录由 API 后台发请求、
 * Worker 经 Redis 队列消费:开有头会话 → 导航到引擎站 → 轮询"未登录指示消失 + 提问框可见"
 * → 成功则把档案置 available 并落 contextRef(登录态持久化),失败/超时写状态供后台展示。
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
    console.log('[login] manager started: waiting for login requests');
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const raw = await this.redis.blpop(LOGIN_REQ_QUEUE, 5);
        if (!raw) continue;
        const req = JSON.parse(raw[1]!) as LoginRequest;
        await this.run(req).catch(async (err) => {
          console.error(`[login] session=${req.sessionId} engine=${req.engine} failed:`, err);
          await this.setStatus(req.sessionId, { state: 'error', detail: String(err), updatedAt: new Date().toISOString() });
        });
      } catch (err) {
        if (!this.stopped) {
          console.error('[login] loop error', err);
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    }
  }

  private async run(req: LoginRequest): Promise<void> {
    if (browserModeFromEnv() === 'mock') {
      await this.setStatus(req.sessionId, {
        state: 'error',
        detail: 'BROWSER_MODE=mock 无真实浏览器;设为 local(本机 Chrome)或 agentbay 后再发起人工登录',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const site = siteConfigOf(req.engine as EngineId);
    const startedAt = Date.now();
    await this.setStatus(req.sessionId, { state: 'running', detail: '正在打开浏览器…', updatedAt: new Date().toISOString() });

    let cdpBrowser: import('playwright-core').Browser | null = null;
    const session = await this.broker.acquire({
      profileKey: req.profileKey,
      contextRef: req.contextRef ?? undefined,
      fingerprint: req.fingerprint,
      proxyHint: req.proxyHint ?? undefined,
      purpose: 'login', // 有头窗口:操作者直接在弹出的浏览器里完成扫码/验证码
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
      console.log(`[login] session=${req.sessionId} engine=${req.engine} 浏览器已打开(${site.displayName}),等待操作者登录…`);

      // 轮询:未登录指示消失 + 提问框可见,连续两轮(间隔 5s)成立才算成功;
      // 操作者登录后若落在非会话页(如站点首页),周期性重导航回提问页再验证
      let confirmStreak = 0;
      let lastNavAt = Date.now();
      while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
        await this.setStatus(req.sessionId, {
          state: 'running',
          detail: `等待登录…(剩余 ${Math.ceil((LOGIN_TIMEOUT_MS - (Date.now() - startedAt)) / 1000)}s,请在弹出的浏览器窗口完成 ${site.displayName} 登录)`,
          updatedAt: new Date().toISOString(),
        });
        const { loggedIn } = await checkLogin(page, site);
        let usable = loggedIn !== false && (await hasVisibleInput(page, site));
        if (!usable && Date.now() - lastNavAt > 15_000) {
          // 登录成功但落在落地页/登录完成页:带回提问页
          await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs }).catch(() => undefined);
          lastNavAt = Date.now();
          usable = loggedIn !== false && (await hasVisibleInput(page, site));
        }
        confirmStreak = usable ? confirmStreak + 1 : 0;
        if (confirmStreak >= 2) break;
        await page.waitForTimeout(5_000);
      }

      const success = confirmStreak >= 2;
      if (success) {
        await this.db
          .update(accountProfiles)
          .set({ status: 'available', contextRef: req.contextRef ?? `local:${req.profileKey}` })
          .where(eq(accountProfiles.id, req.profileId));
        console.log(`[login] session=${req.sessionId} engine=${req.engine} 登录成功,档案 ${req.profileId} 置 available`);
      } else {
        console.warn(`[login] session=${req.sessionId} engine=${req.engine} 登录等待超时`);
      }
      await this.setStatus(req.sessionId, {
        state: success ? 'done' : 'timeout',
        detail: success ? '登录成功,账号已入可用池' : '等待超时:未检测到登录完成,可重试',
        updatedAt: new Date().toISOString(),
      });
    } finally {
      await session.release(); // 本地代理:关闭窗口,登录态已持久化到 profile 目录
      if (cdpBrowser) await cdpBrowser.close().catch(() => undefined);
    }
  }

  private async setStatus(sessionId: string, status: LoginStatus): Promise<void> {
    await this.redis.set(loginStatusKey(sessionId), JSON.stringify(status), 'EX', LOGIN_STATUS_TTL_SEC);
  }
}
