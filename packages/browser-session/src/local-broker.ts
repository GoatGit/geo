import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  BrokerError,
  type SessionBroker,
  type SessionHandle,
  type SessionProfile,
} from './types';

export interface LocalBrokerConfig {
  /** 各账号持久化浏览器 profile 的根目录(UserDataDir = Cookie/登录态,docs/04 §3.2 会话粘性) */
  profileRoot: string;
  /** 浏览器通道:'chrome' 用本机 Chrome,或填 executablePath 对应的通道名 */
  channel?: string;
  headless: boolean;
  /** 空闲多久后关闭浏览器进程(ms);0 = 用完即关 */
  idleCloseMs: number;
  maxConcurrent: number;
}

/**
 * 本地持久化会话代理(docs/04 §2.1 路线 A 的自建降级路径,docs/07 §13 兜底):
 * - 每个账号档案一个 Chromium UserDataDir,登录态跨进程持久化 → 人工登录一次,采集长期复用;
 * - login 用途以有头窗口启动(操作者扫码/输验证码),collect 用途默认无头;
 * - 直接注入 Page(handle.page),worker 无需 connectOverCDP;远程 AgentBay 形状不变。
 */
export class LocalSessionBroker implements SessionBroker {
  private readonly contexts = new Map<string, { context: BrowserContext; refCount: number; idleTimer?: NodeJS.Timeout }>();
  private launching = new Map<string, Promise<BrowserContext>>();

  constructor(private readonly config: LocalBrokerConfig) {}

  async acquire(profile: SessionProfile): Promise<SessionHandle> {
    if (this.contexts.size >= this.config.maxConcurrent && !this.contexts.has(profile.profileKey)) {
      throw new BrokerError(`local broker: concurrent limit ${this.config.maxConcurrent} reached`, 429);
    }
    const context = await this.contextFor(profile);
    const existing = context.pages()[0];
    const page: Page = existing ?? (await context.newPage());
    const key = profile.profileKey;
    const entry = this.contexts.get(key)!;
    entry.refCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const sessionId = `local-${Buffer.from(key).toString('base64url')}`;
    return {
      sessionId,
      cdpUrl: `local://${key}`, // 本地模式不走 CDP:page 已直接注入
      imageId: `local:${this.config.channel ?? 'chrome'}`,
      page,
      release: async () => {
        const e = this.contexts.get(key);
        if (!e) return;
        e.refCount = Math.max(0, e.refCount - 1);
        if (e.refCount > 0) return;
        if (this.config.idleCloseMs > 0) {
          e.idleTimer = setTimeout(() => {
            void this.closeProfile(key);
          }, this.config.idleCloseMs);
          e.idleTimer.unref?.();
        } else {
          await this.closeProfile(key);
        }
      },
    };
  }

  async destroyAll(): Promise<void> {
    await Promise.allSettled([...this.contexts.keys()].map((k) => this.closeProfile(k)));
  }

  /** 登录态目录即 contextRef:人工登录成功后写回 account_profiles.context_ref。 */
  contextRefOf(profileKey: string): string {
    return `local:${profileKey}`;
  }

  private contextFor(profile: SessionProfile): Promise<BrowserContext> {
    const pending = this.launching.get(profile.profileKey);
    if (pending) return pending;
    const task = this.launch(profile).finally(() => this.launching.delete(profile.profileKey));
    this.launching.set(profile.profileKey, task);
    return task;
  }

  private async launch(profile: SessionProfile): Promise<BrowserContext> {
    const existing = this.contexts.get(profile.profileKey);
    if (existing) return existing.context;
    const userDataDir = join(this.config.profileRoot, sanitize(profile.profileKey));
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: this.config.channel,
        headless: profile.purpose === 'login' ? false : this.config.headless,
        viewport: readViewport(profile.fingerprint) ?? { width: 1366, height: 850 },
        locale: 'zh-CN',
        args: ['--disable-blink-features=automation-controlled'],
      });
      context.on('close', () => this.contexts.delete(profile.profileKey));
      this.contexts.set(profile.profileKey, { context, refCount: 0 });
      return context;
    } catch (err) {
      throw new BrokerError(
        `local browser launch failed for ${profile.profileKey}(需本机安装 Chrome 或设 LOCAL_BROWSER_EXECUTABLE)`,
        undefined,
        (err as Error).message,
      );
    }
  }

  private async closeProfile(key: string): Promise<void> {
    const entry = this.contexts.get(key);
    if (!entry) return;
    this.contexts.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.context.close().catch(() => undefined);
  }
}

function sanitize(profileKey: string): string {
  return profileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readViewport(fingerprint: Record<string, unknown>): { width: number; height: number } | null {
  const vp = fingerprint.viewport;
  if (typeof vp === 'string' && /^\d+x\d+$/.test(vp)) {
    const [w, h] = vp.split('x').map(Number);
    return { width: w!, height: h! };
  }
  return null;
}
