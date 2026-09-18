import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@geo/db';
import type { Redis } from 'ioredis';
import type { SessionBroker } from '@geo/browser-session';
import type { LoginRequest } from '@geo/shared';
import { LoginManager } from '../src/login-manager';
import type { ProxyPoolManager } from '../src/qg-proxy';
import { verifyStoredLogin } from '../src/browser-context';

vi.mock('../src/browser-context', async (original) => ({
  ...await original<object>(), verifyStoredLogin: vi.fn(async () => null),
}));

const login = vi.hoisted(() => ({ loggedIn: false as boolean | null }));
vi.mock('@geo/engine-adapters', async (original) => ({
  ...await original<object>(),
  checkLogin: vi.fn(async () => ({ loggedIn: login.loggedIn })),
  hasVisibleInput: vi.fn(async () => true),
}));

const req: LoginRequest = {
  sessionId: 'test-session', profileId: 1, profileKey: 'profile:1', engine: 'doubao',
  fingerprint: {}, contextRef: null, proxyHint: null, requestedAt: new Date().toISOString(),
};

function fixture() {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const state = { cookies: [{ name: 'sessionid', value: 'test' }], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: 'test' }] }] };
  const storageState = vi.fn(async () => state);
  const page = {
    evaluate: async () => ({ ua: 'local-chrome', locale: 'zh-CN', viewport: '1366x850' }),
    goto: vi.fn(async () => undefined), url: () => 'https://www.doubao.com/chat/',
    waitForTimeout: vi.fn(async (ms: number) => { now += ms; }),
    context: () => ({ cookies: async () => state.cookies, storageState, browser: () => ({}) }),
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
  };
  const returning = vi.fn(async () => [{ id: 1 }]);
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ proxyServer: null }] }) }) }),
    update: () => ({ set }),
  };
  const redis = {
    get: vi.fn(async (key: string) => key.includes(':cancel:') && now >= 20_000 ? '1' : null),
    set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1),
  };
  const release = vi.fn(async () => undefined);
  const broker = { acquire: async () => ({ page, release }) };
  const manager = new LoginManager(db as unknown as Db, redis as unknown as Redis, broker as unknown as SessionBroker, {} as ProxyPoolManager);
  return { run: (overrides: Partial<LoginRequest> = {}) => (manager as unknown as { run(req: LoginRequest): Promise<void> }).run({ ...req, ...overrides }), page, set, redis, release, storageState, state, returning };
}

describe('manual account login', () => {
  beforeEach(() => { vi.stubEnv('BROWSER_MODE', 'local'); vi.stubEnv('LOGIN_VIEWER', '0'); login.loggedIn = false; vi.mocked(verifyStoredLogin).mockReset().mockResolvedValue(null); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('does not refresh a login form while the operator enters credentials', async () => {
    const f = fixture();
    await f.run();
    expect(f.page.goto).toHaveBeenCalledTimes(1);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('a visible guest input never makes an account available', async () => {
    login.loggedIn = null;
    const f = fixture();
    await f.run();
    expect(f.set).not.toHaveBeenCalled();
    expect(f.redis.set.mock.calls.some((call) => String(call[1]).includes('"state":"done"'))).toBe(false);
  });

  it('saves both cookies and localStorage before reporting success', async () => {
    login.loggedIn = true;
    const f = fixture();
    await f.run();
    expect(f.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'available', storageState: f.state, cooldownUntil: null }));
    expect(f.release.mock.invocationCallOrder[0]).toBeLessThan(f.set.mock.invocationCallOrder[0]);
  });

  it('does not make the profile available when exporting state fails', async () => {
    login.loggedIn = true;
    const f = fixture();
    f.storageState.mockRejectedValueOnce(new Error('browser closed'));
    await expect(f.run()).rejects.toThrow('browser closed');
    expect(f.set).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('honors cancellation during final verification', async () => {
    login.loggedIn = true;
    const f = fixture();
    f.page.goto.mockImplementation(async () => {
      if (f.page.goto.mock.calls.length === 2) f.redis.get.mockResolvedValue('1');
    });
    await f.run();
    expect(f.set).not.toHaveBeenCalled();
    expect(f.redis.set.mock.calls.some((call) => String(call[1]).includes('"state":"cancelled"'))).toBe(true);
  });

  it('cannot reactivate an account disabled during login', async () => {
    login.loggedIn = true;
    const f = fixture();
    f.returning.mockResolvedValue([]);
    await expect(f.run()).rejects.toThrow('账号状态已改变');
    expect(f.redis.set.mock.calls.some((call) => String(call[1]).includes('"state":"done"'))).toBe(false);
  });

  it('keeps DeepSeek out of the pool when exported login cannot be restored', async () => {
    login.loggedIn = true;
    const f = fixture();
    await f.run({ engine: 'deepseek' });
    expect(verifyStoredLogin).toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
    expect(f.redis.set.mock.calls.some((call) => String(call[1]).includes('"state":"done"'))).toBe(false);
  });

  it('persists the verified DeepSeek state, including credentials refreshed during restoration', async () => {
    login.loggedIn = true;
    const f = fixture();
    const verified = { cookies: [], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: '{"value":"refreshed"}' }] }] };
    vi.mocked(verifyStoredLogin).mockResolvedValue(verified);
    await f.run({ engine: 'deepseek' });
    expect(f.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'available', storageState: verified, proxyServer: null }));
  });

  it('does not complete DeepSeek login when cancelled during the restoration check', async () => {
    login.loggedIn = true;
    const f = fixture();
    vi.mocked(verifyStoredLogin).mockImplementation(async () => {
      f.redis.get.mockResolvedValue('1');
      return { cookies: [], origins: [] };
    });
    await f.run({ engine: 'deepseek' });
    expect(f.set).not.toHaveBeenCalled();
  });
});
