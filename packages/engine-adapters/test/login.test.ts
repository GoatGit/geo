import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { checkLogin, ENGINE_SITES } from '../src';

function pageFor(url: string, cookies: Array<{ name: string; value: string }> = [], token: unknown = null) {
  return {
    url: () => url,
    context: () => ({ cookies: async () => cookies }),
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    evaluate: vi.fn(async () => token),
  } as unknown as Page;
}

describe('login evidence', () => {
  it('explicit logout redirects override stale cookies', async () => {
    const page = pageFor('https://www.doubao.com/chat/?from_logout=1', [{ name: 'sessionid', value: 'stale' }]);
    expect((await checkLogin(page, ENGINE_SITES.doubao)).loggedIn).toBe(false);
  });

  it('empty cookie values are not login evidence', async () => {
    const page = pageFor(ENGINE_SITES.doubao.chatUrl, [{ name: 'sessionid', value: '' }]);
    expect((await checkLogin(page, ENGINE_SITES.doubao)).loggedIn).not.toBe(true);
  });

  it('another origin cannot supply login evidence', async () => {
    const page = pageFor('https://example.com/', [{ name: 'sessionid', value: 'unrelated' }]);
    expect((await checkLogin(page, ENGINE_SITES.doubao)).loggedIn).not.toBe(true);
  });

  it('DeepSeek recognizes its persisted user token on the chat origin', async () => {
    const page = pageFor(ENGINE_SITES.deepseek.chatUrl, [], 'token');
    expect((await checkLogin(page, ENGINE_SITES.deepseek)).loggedIn).toBe(true);
  });

  it('DeepSeek sign-in page remains logged out even with stale credentials', async () => {
    const page = pageFor('https://chat.deepseek.com/sign_in', [{ name: 'sessionid', value: 'stale' }], 'token');
    expect((await checkLogin(page, ENGINE_SITES.deepseek)).loggedIn).toBe(false);
  });
});
