import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSessionBroker } from '../src/local-broker';
import { chromium } from 'playwright-core';

vi.mock('node:child_process', () => ({ execFile: vi.fn((_cmd, _args, callback) => callback()) }));
vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: vi.fn(async () => ({ pages: () => [{}], on: vi.fn(), close: vi.fn(async () => undefined) })) } }));
afterEach(() => vi.clearAllMocks());

describe('local login window', () => {
  it.each([false, true])('viewer=%s controls whether login is headless', async (viewerLogin) => {
    const broker = new LocalSessionBroker({ profileRoot: '/tmp/geo-login-test', headless: true, idleCloseMs: 0, maxConcurrent: 1, viewerLogin });
    await broker.acquire({ profileKey: 'profile:1', fingerprint: {}, purpose: 'login' });
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headless: viewerLogin }));
  });

  it('refuses login while the same profile is collecting', async () => {
    const broker = new LocalSessionBroker({ profileRoot: '/tmp/geo-login-test', headless: true, idleCloseMs: 1000, maxConcurrent: 1 });
    const active = await broker.acquire({ profileKey: 'profile:1', fingerprint: {}, purpose: 'collect' });
    await expect(broker.acquire({ profileKey: 'profile:1', fingerprint: {}, purpose: 'login' })).rejects.toThrow('busy');
    await active.release();
    await broker.destroyAll();
  });

  it('reopens an idle collection context as a visible login window', async () => {
    const broker = new LocalSessionBroker({ profileRoot: '/tmp/geo-login-test', headless: true, idleCloseMs: 1000, maxConcurrent: 1 });
    const active = await broker.acquire({ profileKey: 'profile:1', fingerprint: {}, purpose: 'collect' });
    await active.release();
    const login = await broker.acquire({ profileKey: 'profile:1', fingerprint: {}, purpose: 'login' });
    expect(chromium.launchPersistentContext).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ headless: false }));
    await login.release();
  });
});
