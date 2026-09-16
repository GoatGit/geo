import { describe, expect, it, vi, afterEach } from 'vitest';
import { MockSessionBroker } from '../src/mock-broker';
import { AgentBaySessionBroker } from '../src/agentbay-broker';
import { BrokerError } from '../src/types';
import { createBrokerFromEnv } from '../src';
import type { SessionProfile } from '../src/types';

const profile: SessionProfile = {
  profileKey: 'profile:5',
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

/**
 * POP RPC 协议(docs/07 §4 W1-2 校准):POST form,Action 区分动作,
 * 响应 JSON/XML 双形态。这里用 JSON 形态 stub,断言调用次序与参数。
 */
describe('AgentBaySessionBroker(PoC 闸门:路径形状见 docs/07 §13)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 按 Action 分发 stub:actions[Action] 返回对象或抛 {code,message,status} */
  function stubRpc(actions: Record<string, (() => unknown) | unknown>) {
    const calls: Array<{ action: string; fields: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const form = new URLSearchParams(String(init?.body ?? ''));
        const action = form.get('Action') ?? '';
        const fields = Object.fromEntries(form.entries());
        calls.push({ action, fields });
        const def = actions[action];
        if (!def) return new Response(JSON.stringify({ Code: 'InvalidAction' }), { status: 400 });
        const out = typeof def === 'function' ? def() : def;
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200 });
      }),
    );
    return calls;
  }

  const ok = (data: unknown) => ({ Code: 'ok', Success: true, Data: data });
  const fail = (code: string, message: string) => ({ Code: code, Message: message });

  it('acquire:GetContext → CreateMcpSession(带 ContextId) → InitBrowser → GetCdpLink;release 销毁', async () => {
    const calls = stubRpc({
      GetContext: ok({ Id: 'SdkCtx-1', State: 'available', Name: 'geo-profile-5' }),
      CreateMcpSession: ok({ SessionId: 'sess-1', WsUrl: 'wss://mcp' }),
      InitBrowser: ok({}),
      GetCdpLink: ok({ Url: 'wss://cdp/token' }),
      ReleaseMcpSession: ok({}),
    });

    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com',
      apiKey: 'k',
      imageId: 'browser_latest',
      regionId: 'cn-hangzhou',
    });
    const h = await broker.acquire(profile);
    expect(h.sessionId).toBe('sess-1');
    expect(h.cdpUrl).toBe('wss://cdp/token');
    expect(h.contextId).toBe('SdkCtx-1');

    const byAction = Object.fromEntries(calls.map((c) => [c.action, c]));
    // Context 名由 profileKey 派生
    expect(byAction.GetContext.fields.Name).toBe('geo-profile-5');
    expect(byAction.GetContext.fields.AllowCreate).toBe('true');
    // 会话绑定 Context + 镜像 + 区域
    expect(byAction.CreateMcpSession.fields.ContextId).toBe('SdkCtx-1');
    expect(byAction.CreateMcpSession.fields.ImageId).toBe('browser_latest');
    expect(byAction.CreateMcpSession.fields.RegionId).toBe('cn-hangzhou');

    await h.release();
    expect(calls.at(-1)?.action).toBe('ReleaseMcpSession');
    expect(calls.at(-1)?.fields.SessionId).toBe('sess-1');
  });

  it('Context 被拒(AccessDenied/租户未加白):自动降级为无 Context 会话,流程不中断', async () => {
    const calls = stubRpc({
      GetContext: ok({ Id: 'SdkCtx-2', State: 'available' }),
      CreateMcpSession: () => {
        const last = calls.at(-1)!;
        if (last.fields.ContextId) {
          return new Response(
            JSON.stringify({ Code: 'Context.AccessDenied', Message: 'tenantId not in whitelist' }),
            { status: 400 },
          );
        }
        return ok({ SessionId: 'sess-2' });
      },
      GetCdpLink: ok({ Url: 'wss://cdp/no-ctx' }),
      ReleaseMcpSession: ok({}),
    });

    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com',
      apiKey: 'k',
      imageId: 'browser_latest',
    });
    const h = await broker.acquire(profile);
    // 降级成功:会话可用,但不再声明 Context(登录态不跨会话保留)
    expect(h.sessionId).toBe('sess-2');
    expect(h.cdpUrl).toBe('wss://cdp/no-ctx');
    expect(h.contextId).toBeUndefined();
    // CreateMcpSession 被调两次:带 Context 拒 → 不带 Context 成
    const creates = calls.filter((c) => c.action === 'CreateMcpSession');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.fields.ContextId).toBe('SdkCtx-2');
    expect(creates[1]!.fields.ContextId).toBeUndefined();
  });

  it('GetCdpLink 失败:销毁会话并抛 BrokerError(防泄漏)', async () => {
    stubRpc({
      GetContext: ok({ Id: 'SdkCtx-3' }),
      CreateMcpSession: ok({ SessionId: 's3' }),
      InitBrowser: ok({}),
      GetCdpLink: fail('NoCdpUrl', 'no endpoint'),
      ReleaseMcpSession: ok({}),
    });
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://x', apiKey: 'k', imageId: 'browser_latest',
    });
    await expect(broker.acquire(profile)).rejects.toBeInstanceOf(BrokerError);
  });

  it('缺 API token 直接拒绝', () => {
    expect(() => new AgentBaySessionBroker({ apiEndpoint: 'x', apiKey: '', imageId: 'browser_latest' })).toThrow(
      BrokerError,
    );
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
