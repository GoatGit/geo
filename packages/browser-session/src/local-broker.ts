import { execFile } from 'node:child_process';
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
  /** 远程可视化登录模式:登录会话也无头,操作者经后台 viewer 操控(生产 agentbay 同构) */
  viewerLogin?: boolean;
}

/**
 * 本地持久化会话代理(docs/04 §2.1 路线 A 的自建降级路径,docs/07 §13 兜底):
 * - 每个账号档案一个 Chromium UserDataDir,登录态跨进程持久化 → 人工登录一次,采集长期复用;
 * - login 用途以有头窗口启动(操作者扫码/输验证码),collect 用途默认无头;
 * - 直接注入 Page(handle.page),worker 无需 connectOverCDP;远程 AgentBay 形状不变。
 */
export class LocalSessionBroker implements SessionBroker {
  private readonly contexts = new Map<
    string,
    { context: BrowserContext; refCount: number; idleTimer?: NodeJS.Timeout; purpose: 'collect' | 'login' }
  >();
  private launching = new Map<string, Promise<BrowserContext>>();

  constructor(private readonly config: LocalBrokerConfig) {}

  async acquire(profile: SessionProfile): Promise<SessionHandle> {
    const purpose = profile.purpose ?? 'collect';
    const inUse = this.contexts.get(profile.profileKey);
    if (inUse?.refCount && (purpose === 'login' || inUse.purpose === 'login')) {
      throw new BrokerError('local profile busy: 请等待当前会话结束后重试登录', 409);
    }
    if (this.contexts.size >= this.config.maxConcurrent && !this.contexts.has(profile.profileKey)) {
      throw new BrokerError(`local broker: concurrent limit ${this.config.maxConcurrent} reached`, 429);
    }
    const context = await this.contextFor(profile);
    const key = profile.profileKey;
    const entry = this.contexts.get(key)!;
    if (entry.refCount && (purpose === 'login' || entry.purpose === 'login')) {
      throw new BrokerError('local profile busy: 请等待当前会话结束后重试登录', 409);
    }
    entry.refCount += 1;
    entry.purpose = purpose;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const existing = context.pages()[0];
    const page: Page = existing ?? (await context.newPage());
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
        // 登录会话结束必须立即干净退出:Cookie 刷盘后采集进程才能读到登录态;
        // 若走空闲复用窗口,跨进程交接时清锁会杀死未刷盘的浏览器(登录态丢失)
        if (e.purpose === 'login' || this.config.idleCloseMs <= 0) {
          await this.closeProfile(key);
          return;
        }
        e.idleTimer = setTimeout(() => {
          void this.closeProfile(key);
        }, this.config.idleCloseMs);
        e.idleTimer.unref?.();
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
    if (existing) {
      if (existing.purpose === (profile.purpose ?? 'collect')) return existing.context;
      if (existing.refCount > 0) throw new BrokerError('local profile busy', 409);
      await this.closeProfile(profile.profileKey);
    }
    const userDataDir = join(this.config.profileRoot, sanitize(profile.profileKey));
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: this.config.channel,
        // viewer 登录模式:登录会话也无头(操作者经后台 viewer 操控,生产与 agentbay 同构)
        headless: profile.purpose === 'login' ? Boolean(this.config.viewerLogin) : this.config.headless,
        viewport: readViewport(profile.fingerprint) ?? { width: 1366, height: 850 },
        locale: 'zh-CN',
        args: ['--disable-blink-features=automation-controlled'],
      });
      context.on('close', () => {
        // closeProfile owns cleanup during an intentional restart. Never let an
        // old context's close event kill a newly opened login browser.
        if (this.contexts.get(profile.profileKey)?.context === context) {
          this.contexts.delete(profile.profileKey);
        }
      });
      this.contexts.set(profile.profileKey, { context, refCount: 0, purpose: profile.purpose ?? 'collect' });
      return context;
    } catch (err) {
      // 残留进程占用 profile 目录(上个会话异常退出):清场后重试一次
      if (/ProcessSingleton|Failed to create|ReuseProfile|SingletonLock/i.test(String(err))) {
        await this.killProfileProcesses(profile.profileKey);
        await new Promise((r) => setTimeout(r, 1_500));
        return this.launch(profile);
      }
      throw new BrokerError(
        `local browser launch failed for ${profile.profileKey}(查 Chrome 是否安装;若报 ProcessSingleton 则有残留进程占用 profile 目录)`,
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
    await this.killProfileProcesses(key); // 兜底强杀,防止残留进程占用 profile 目录锁
  }

  /** 按用户数据目录杀残留浏览器进程(操作者关窗触发 context close 后,进程可能滞留)。 */
  private async killProfileProcesses(key: string): Promise<void> {
    const dir = join(this.config.profileRoot, sanitize(key));
    await new Promise<void>((resolve) => {
      execFile('pkill', ['-f', dir], () => resolve());
    });
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
