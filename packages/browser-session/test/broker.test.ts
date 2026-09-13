import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MockSessionBroker } from '../src/mock-broker';
import { AgentBaySessionBroker, AgentBayClient } from '../src/agentbay-broker';
import { BrokerError } from '../src/types';
import { createBrokerFromEnv } from '../src';
import type { SessionProfile } from '../src/types';

const profile: SessionProfile = {
  profileKey: 'doubao-p1',
  contextRef: 'ctx-9',
  fingerprint: { ua: 'UA', viewport: '1366x768' },
  proxyHint: 'residential:cn-sh-1',
};

describe('MockSessionBroker', () => {
  it('acquire 计数 / release 释放 / 超并发抛 429', async () => {
    const broker = new MockSessionBroker(1);
    const h1 = await broker.acquire(profile);
    expect(h1.cdpUrl).toContain('mock://cdp/');
    await expect(broker.acquire(profile)).rejects.toMatchObject({ status: 429 });
    await h1.release();
    expect(broker.active.size).toBe(0);
    const h2 = await broker.acquire(profile);
    expect(h2.sessionId).not.toBe(h1.sessionId);
    await h2.release();
  });
});

describe('AgentBaySessionBroker(PoC 闸门:路径形状见 docs/07 §13)', () => {
  beforeEach(() => vi.restoreAllMocks());

  function stubFetch(responses: Array<{ match: (url: string, init?: RequestInit) => boolean; body: unknown; status?: number }>) {
    return vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const hit = responses.find((r) => r.match(url, init));
        if (!hit) throw new Error(`unexpected fetch ${url}`);
        return new Response(
          typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body),
          { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
  }

  it('acquire:创建 → 初始化 → 取端点;release 销毁', async () => {
    const calls: string[] = [];
    stubFetch([
      {
        match: (u, i) => u.endsWith('/api/v2/sessions') && i?.method === 'POST',
        body: { sessionId: 'sess-1' },
      },
      { match: (u) => u.includes('/sess-1/browser/initialize'), body: { ok: true } },
      { match: (u) => u.includes('/sess-1/browser/endpoint'), body: { endpointUrl: 'wss://cdp/token' } },
      { match: (u, i) => u.endsWith('/api/v2/sessions/sess-1') && i?.method === 'DELETE', body: { ok: true } },
    ]);
    // 记录调用顺序
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ sessionId: 'sess-1', endpointUrl: 'wss://cdp/token', ok: true }), {
        status: 200,
      });
    });

    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com',
      apiKey: 'k',
      imageId: 'browser_latest',
    });
    const h = await broker.acquire(profile);
    expect(h.cdpUrl).toBe('wss://cdp/token');
    expect(h.imageId).toBe('browser_latest');
    await h.release();
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true);
  });

  it('初始化失败:自动销毁会话并抛 BrokerError(防泄漏)', async () => {
    stubFetch([
      { match: (u, i) => u.endsWith('/api/v2/sessions') && i?.method === 'POST', body: { sessionId: 's2' } },
      { match: (u) => u.includes('/browser/initialize'), body: 'boom', status: 500 },
      { match: (u, i) => u.endsWith('/api/v2/sessions/s2') && i?.method === 'DELETE', body: { ok: true } },
    ]);
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://x', apiKey: 'k', imageId: 'browser_latest',
    });
    await expect(broker.acquire(profile)).rejects.toBeInstanceOf(BrokerError);
  });

  it('缺 API token 直接拒绝', () => {
    expect(() => new AgentBayClient({ apiEndpoint: 'x', apiKey: '', imageId: 'browser_latest' })).toThrow(BrokerError);
  });
});

describe('createBrokerFromEnv', () => {
  it('默认 mock;agentbay 模式构建 AgentBay 实现', () => {
    expect(createBrokerFromEnv({ BROWSER_MODE: 'mock' })).toBeInstanceOf(MockSessionBroker);
    expect(
      createBrokerFromEnv({ BROWSER_MODE: 'agentbay', AGENTBAY_API_TOKEN: 't' }),
    ).toBeInstanceOf(AgentBaySessionBroker);
  });
});
