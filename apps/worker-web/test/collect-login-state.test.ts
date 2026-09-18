import { describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { CollectProcessor } from '../src/processor';
import type { AcquiredProfile } from '../src/profiles';
import type { AskResult } from '@geo/engine-adapters';

vi.mock('@geo/engine-adapters', async (original) => ({
  ...await original<object>(), checkLogin: vi.fn(async () => ({ loggedIn: true })),
}));

vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: vi.fn() } }));

describe('collection login state handoff', () => {
  it.each([null, { server: '127.0.0.1:1000', egressIp: '127.0.0.1' }])('restores DeepSeek localStorage with proxy %j before asking', async (lease) => {
    const storageState = { cookies: [], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: '{"value":"test-token"}' }] }] };
    const refreshed = { ...storageState, origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: '{"value":"refreshed"}' }] }] };
    const page = { context: () => ({ storageState: async () => refreshed }) };
    const newContext = vi.fn(async () => ({ pages: () => [page], addCookies: vi.fn() }));
    vi.mocked(chromium.connectOverCDP).mockResolvedValue({ newContext, close: vi.fn(async () => undefined) } as never);
    const ask = vi.fn(async () => ({ status: 'ok_with_answer' }));
    const release = vi.fn();
    const saveStorageState = vi.fn();
    const processor = Object.assign(Object.create(CollectProcessor.prototype), {
      broker: { acquire: async () => ({ cdpUrl: 'wss://test', release }) },
      proxyPool: { acquireForProfile: async () => ({ lease, rotated: false }) },
      realBrowser: true,
      pool: { saveStorageState },
      registry: { get: () => ({ ask }) },
    }) as { askWithTimeout(engine: string, profile: AcquiredProfile, question: string): Promise<{ ask: AskResult }> };
    const result = await processor.askWithTimeout('deepseek', { id: 1, profileKey: 'profile:1', fingerprint: {}, proxyHint: null, proxyServer: null, contextRef: null, cookies: null, storageState }, 'test question');
    expect(result.ask.status, JSON.stringify(result.ask.engineMeta)).toBe('ok_with_answer');
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState, locale: 'zh-CN' }));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ page }), 'test question', expect.any(Object));
    expect(release).toHaveBeenCalledOnce();
    expect(saveStorageState).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), refreshed);
  });
});
