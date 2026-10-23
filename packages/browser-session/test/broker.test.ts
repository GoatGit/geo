import { describe, expect, it, vi, afterEach } from 'vitest';
import { MockSessionBroker } from '../src/mock-broker';
import { AgentBaySessionBroker } from '../src/agentbay-broker';
import { BrokerError } from '../src/types';
import { createBrokerFromEnv } from '../src';
import type { SessionProfile, SessionRegistry, SessionRegistryEntry } from '../src/types';

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

  /** 释放调用序列(按 SessionId),用于断言幂等/兜底是否真的发了 RPC。 */
  const releasedIds = (calls: Array<{ action: string; fields: Record<string, string> }>) =>
    calls.filter((c) => c.action === 'ReleaseMcpSession').map((c) => c.fields.SessionId);

  /** acquire 全链路成功所需的最小动作集。 */
  const okActions = (sessionId: string) => ({
    GetContext: ok({ Id: 'SdkCtx-1' }),
    CreateMcpSession: ok({ SessionId: sessionId }),
    BindContexts: ok({}),
    DescribeSessionContexts: ok([{ ContextId: 'SdkCtx-1' }]),
    InitBrowser: ok({}),
    GetCdpLink: ok({ Url: 'wss://cdp/token' }),
    ReleaseMcpSession: ok({}),
  });

  class FakeRegistry implements SessionRegistry {
    readonly entries = new Map<string, SessionRegistryEntry>();
    failTrack = false;

    async track(entry: SessionRegistryEntry): Promise<void> {
      if (this.failTrack) throw new Error('redis down');
      this.entries.set(entry.sessionId, entry);
    }

    async forget(sessionId: string): Promise<void> {
      this.entries.delete(sessionId);
    }

    async listOlderThan(staleBefore: number): Promise<SessionRegistryEntry[]> {
      return [...this.entries.values()].filter((e) => e.createdAt <= staleBefore);
    }
  }

  it('acquire:GetContext → CreateMcpSession(废弃的 ContextId 直传已移除)→ BindContexts → GetCdpLink;release 销毁', async () => {
    const calls = stubRpc({
      GetContext: ok({ Id: 'SdkCtx-1', State: 'available', Name: 'geo-profile-5' }),
      CreateMcpSession: ok({ SessionId: 'sess-1', WsUrl: 'wss://mcp' }),
      BindContexts: ok({}),
      DescribeSessionContexts: ok([{ ContextId: 'SdkCtx-1', Path: '/home/wuying/workspace' }]),
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
    // 废弃传参不得再出现:CreateMcpSession 不携带 ContextId
    expect(byAction.CreateMcpSession.fields.ContextId).toBeUndefined();
    expect(byAction.CreateMcpSession.fields.ImageId).toBe('browser_latest');
    expect(byAction.CreateMcpSession.fields.RegionId).toBe('cn-hangzhou');
    // 持久化走 BindContexts(PersistenceDataList,PascalCase 元素)+ 绑定登记可查
    const pdl = JSON.parse(byAction.BindContexts.fields.PersistenceDataList) as Array<Record<string, string>>;
    expect(pdl).toEqual([{ ContextId: 'SdkCtx-1', Path: '/home/wuying/workspace' }]);
    expect(byAction.BindContexts.fields.SessionId).toBe('sess-1');
    expect(byAction.DescribeSessionContexts.fields.SessionId).toBe('sess-1');

    await h.release();
    expect(calls.at(-1)?.action).toBe('ReleaseMcpSession');
    expect(calls.at(-1)?.fields.SessionId).toBe('sess-1');
  });

  it('BindContexts 被拒(AccessDenied):自动降级为无 Context 会话,流程不中断', async () => {
    const calls = stubRpc({
      GetContext: ok({ Id: 'SdkCtx-2', State: 'available' }),
      CreateMcpSession: ok({ SessionId: 'sess-2' }),
      BindContexts: () =>
        new Response(
          JSON.stringify({ Code: 'Context.AccessDenied', Message: 'tenantId not in whitelist' }),
          { status: 400 },
        ),
      InitBrowser: ok({}),
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
    // 绑定失败后流程继续:InitBrowser/GetCdpLink 照常,不再轮询绑定登记
    const actions = calls.map((c) => c.action);
    expect(actions).toContain('InitBrowser');
    expect(actions).toContain('GetCdpLink');
    expect(actions).not.toContain('DescribeSessionContexts');
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

  it('会话超过应用侧 TTL 自动释放(调用方卡死/漏调 release 的兜底)', async () => {
    const calls = stubRpc(okActions('sess-ttl'));
    const registry = new FakeRegistry();
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com',
      apiKey: 'k',
      imageId: 'browser_latest',
      sessionRegistry: registry,
      sessionMaxAgeMs: { collect: 40 },
    });
    const h = await broker.acquire({ ...profile, purpose: 'collect' });
    expect(releasedIds(calls)).toHaveLength(0);
    expect(registry.entries.get(h.sessionId)?.purpose).toBe('collect');

    await new Promise((r) => setTimeout(r, 150));
    expect(releasedIds(calls)).toEqual(['sess-ttl']);
    expect(registry.entries.size).toBe(0); // 释放成功即注销登记

    await h.release(); // 幂等:TTL 已释放过,不再发第二次
    expect(releasedIds(calls)).toHaveLength(1);
  });

  it('release 幂等:重复调用只释放一次且注销登记', async () => {
    const calls = stubRpc(okActions('sess-1'));
    const registry = new FakeRegistry();
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest', sessionRegistry: registry,
    });
    const h = await broker.acquire(profile);
    expect(registry.entries.size).toBe(1);

    await h.release();
    await h.release();
    expect(releasedIds(calls)).toEqual(['sess-1']);
    expect(registry.entries.size).toBe(0);
  });

  it('释放失败保留登记(交给清扫重试),会话已不存在则视为释放完成', async () => {
    const failing = stubRpc({ ...okActions('sess-fail'), ReleaseMcpSession: fail('InternalError', 'boom') });
    const registry = new FakeRegistry();
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest', sessionRegistry: registry,
    });
    const h = await broker.acquire(profile);
    await h.release();
    expect(releasedIds(failing)).toEqual(['sess-fail']);
    expect(registry.entries.has('sess-fail')).toBe(true);

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(fail('InvalidSession.NotFound', 'gone')), { status: 200 })));

    // 清扫到龄后重试:会话已不存在 → 视为释放完成并注销,不再无限重试
    await registry.track({ sessionId: 'sess-fail', createdAt: Date.now() - 60 * 60_000, purpose: 'collect' });
    expect(await broker.sweepStaleSessions()).toBe(1);
    expect(registry.entries.size).toBe(0);
  });

  it('清扫只释放登记年龄超过上限的会话,不误杀其他实例在用的会话', async () => {
    const calls = stubRpc({ ReleaseMcpSession: ok({}) });
    const registry = new FakeRegistry();
    const now = Date.now();
    // 默认上限:login 25min / collect 9min
    await registry.track({ sessionId: 'stale-login', createdAt: now - 40 * 60_000, purpose: 'login' });
    await registry.track({ sessionId: 'fresh-login', createdAt: now - 60_000, purpose: 'login' });
    await registry.track({ sessionId: 'stale-collect', createdAt: now - 20 * 60_000, purpose: 'collect' });
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest', sessionRegistry: registry,
    });

    expect(await broker.sweepStaleSessions()).toBe(2);
    expect(releasedIds(calls).sort()).toEqual(['stale-collect', 'stale-login']);
    expect([...registry.entries.keys()]).toEqual(['fresh-login']);
  });

  it('登记失败不阻断 acquire(仅失去崩溃后回收线索)', async () => {
    stubRpc(okActions('sess-noreg'));
    const registry = new FakeRegistry();
    registry.failTrack = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest', sessionRegistry: registry,
    });
    const h = await broker.acquire(profile);
    expect(h.sessionId).toBe('sess-noreg');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('会话登记失败'),
      'redis down',
    );
    warn.mockRestore();
  });
  it('创建响应超时(云端实际已建出会话):按 attempt 标签反查并释放,再抛原错误', async () => {
    const calls = stubRpc({
      GetContext: ok({ Id: 'SdkCtx-1' }),
      CreateMcpSession: fail('DEFAULT_SYS_ERROR', 'sendCommandMessage failed: timeout'),
      ListSession: ok([{ SessionId: 'sess-orphan', SessionStatus: 'RUNNING' }]),
      ReleaseMcpSession: ok({}),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest',
    });

    await expect(broker.acquire(profile)).rejects.toThrow(/DEFAULT_SYS_ERROR/);

    // 反查用本次 acquire 独有的 attempt 标签(不是与快照做差集,避免误杀其他实例刚建好的会话)
    const listCall = calls.find((c) => c.action === 'ListSession');
    expect(listCall?.fields.Authorization).toBe('Bearer k');
    const listLabels = JSON.parse(String(listCall?.fields.Labels ?? '{}')) as Record<string, string>;
    expect(listLabels.app).toBe('geolens');
    expect(listLabels.attempt).toMatch(/^[0-9a-f-]{36}$/);
    // 创建时带的就是同一个 attempt
    const createLabels = JSON.parse(
      String(calls.find((c) => c.action === 'CreateMcpSession')?.fields.Labels ?? '{}'),
    ) as Record<string, string>;
    expect(createLabels.attempt).toBe(listLabels.attempt);
    // 无主会话被释放,且日志可见
    expect(releasedIds(calls)).toEqual(['sess-orphan']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('云端已建出会话'));
    warn.mockRestore();
  });

  it('创建失败且反查也失败:不掩盖原错误,只告警', async () => {
    stubRpc({
      GetContext: ok({ Id: 'SdkCtx-1' }),
      CreateMcpSession: fail('DEFAULT_SYS_ERROR', 'sendCommandMessage failed: timeout'),
      ListSession: fail('InternalError', 'list boom'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest',
    });

    await expect(broker.acquire(profile)).rejects.toThrow(/DEFAULT_SYS_ERROR/);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('无法反查会话'), expect.anything());
    error.mockRestore();
  });

  it('创建成功路径不额外查询会话列表(不增加正常链路开销)', async () => {
    const calls = stubRpc(okActions('sess-no-list'));
    const broker = new AgentBaySessionBroker({
      apiEndpoint: 'https://agentbay.example.com', apiKey: 'k', imageId: 'browser_latest',
    });
    const h = await broker.acquire(profile);
    expect(h.sessionId).toBe('sess-no-list');
    expect(calls.some((c) => c.action === 'ListSession')).toBe(false);
    await h.release();
  });
});

describe('createBrokerFromEnv', () => {
  it('默认 mock;agentbay 模式构建 AgentBay 实现', () => {
    expect(createBrokerFromEnv({ BROWSER_MODE: 'mock' })).toBeInstanceOf(MockSessionBroker);
    expect(
      createBrokerFromEnv({ BROWSER_MODE: 'agentbay', AGENTBAY_API_TOKEN: 't' }),
    ).toBeInstanceOf(AgentBaySessionBroker);
  });

  it('agentbay 模式注入会话登记后具备清扫能力', () => {
    const registry: SessionRegistry = {
      async track() {},
      async forget() {},
      async listOlderThan() { return []; },
    };
    const broker = createBrokerFromEnv(
      { BROWSER_MODE: 'agentbay', AGENTBAY_API_TOKEN: 't' },
      { sessionRegistry: registry },
    );
    expect(broker).toBeInstanceOf(AgentBaySessionBroker);
    expect(typeof broker.sweepStaleSessions).toBe('function');
    expect(typeof broker.releaseById).toBe('function');
  });
});
