import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { browserContextOptions, verifyStoredLogin } from '../src/browser-context';
import { ENGINE_SITES } from '@geo/engine-adapters';

vi.mock('@geo/engine-adapters', async (original) => ({
  ...await original<object>(),
  checkLogin: vi.fn(async (page: { authenticated: boolean }) => ({ loggedIn: page.authenticated })),
  hasVisibleInput: vi.fn(async () => true),
}));

const fingerprint = { ua: 'test-agent', locale: 'zh-CN', viewport: '1366x768' };
const state = { cookies: [], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [
  { name: 'userToken', value: '{"value":"token"}' },
  { name: 'deepseek-device-id:chat', value: 'device-1' },
] }] };

describe('portable browser login', () => {
  it('keeps browser identity and proxy identical across login and collection', () => {
    expect(browserContextOptions(fingerprint, 'proxy:80', state)).toEqual({
      userAgent: 'test-agent', locale: 'zh-CN', viewport: { width: 1366, height: 768 },
      proxy: { server: 'http://proxy:80' }, storageState: state,
    });
  });

  it('ignores invalid viewport values', () => {
    expect(browserContextOptions({ viewport: '0x-1' }, null).viewport).toEqual({ width: 1366, height: 850 });
  });

  it.each([true, false])('checks restored credentials before allowing login success: %s', async (authenticated) => {
    const page = { authenticated, goto: vi.fn(), waitForTimeout: vi.fn(), waitForSelector: vi.fn(async () => undefined) };
    const close = vi.fn();
    const refreshed = { ...state, cookies: [{ name: 'refreshed', value: 'new' }] };
    const newContext = vi.fn(async () => ({ newPage: async () => page, close, storageState: async () => refreshed }));
    const result = await verifyStoredLogin({ newContext } as unknown as Browser, ENGINE_SITES.deepseek, fingerprint, null, state);
    expect(result).toEqual(authenticated ? refreshed : null);
    expect(newContext).toHaveBeenCalledWith(browserContextOptions(fingerprint, null, state));
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the verification context when navigation fails', async () => {
    const close = vi.fn();
    const browser = { newContext: async () => ({ close, newPage: async () => ({ goto: async () => { throw Error('network'); } }) }) };
    await expect(verifyStoredLogin(browser as unknown as Browser, ENGINE_SITES.deepseek, fingerprint, null, state)).rejects.toThrow('network');
    expect(close).toHaveBeenCalledOnce();
  });
});
