import { describe, expect, it, vi } from 'vitest';
import { ProxyPoolManager, QgProxyPool } from '../src/qg-proxy';

type LeaseSeed = { server: string; proxy_ip: string; deadline?: string };

/** 青果 API stub:/query 返回在用列表,/get 返回提取结果;记录调用以断言网络行为。 */
function stubQg(opts: { inUse?: LeaseSeed[]; extracted?: LeaseSeed; getCode?: string }) {
  const calls: string[] = [];
  const respond = (url: string) => {
    calls.push(url);
    if (url.includes('/query')) {
      return { code: 'SUCCESS', data: opts.inUse ?? [] };
    }
    if (url.includes('/get')) {
      return opts.extracted
        ? { code: opts.getCode ?? 'SUCCESS', data: { ips: [opts.extracted] } }
        : { code: opts.getCode ?? 'NO_AVAILABLE_CHANNEL', message: 'no channel' };
    }
    return {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(respond(String(url))),
    })) as unknown as typeof fetch,
  );
  return calls;
}

const L1: LeaseSeed = { server: '1.2.3.4:1000', proxy_ip: '61.1.1.1' };
const L2: LeaseSeed = { server: '5.6.7.8:2000', proxy_ip: '61.2.2.2' };

describe('QgProxyPool.acquireForProfile(IP 亲和)', () => {
  it('无绑定:优先复用在用租约,不提取新通道', async () => {
    const calls = stubQg({ inUse: [L1, L2] });
    const pool = new QgProxyPool('k');
    const r = await pool.acquireForProfile(null);
    expect(r.lease?.server).toBe('1.2.3.4:1000');
    expect(r.rotated).toBe(false);
    expect(calls.filter((u) => u.includes('/get'))).toHaveLength(0);
  });

  it('绑定命中:原样返回绑定租约,零网络请求', async () => {
    const calls = stubQg({ inUse: [L1, L2] });
    const pool = new QgProxyPool('k');
    await pool.acquireForProfile(null); // 预热租约表
    const before = calls.length;
    const r = await pool.acquireForProfile('5.6.7.8:2000');
    expect(r.lease?.server).toBe('5.6.7.8:2000');
    expect(r.rotated).toBe(false);
    expect(calls.length).toBe(before); // 命中绑定不发网络请求
  });

  it('绑定的租约消失:分配另一存活租约并标 rotated=true(调用方须按出口切换处理)', async () => {
    stubQg({ inUse: [L1, L2] });
    const pool = new QgProxyPool('k');
    await pool.acquireForProfile(null); // 灌入 L1/L2
    const r = await pool.acquireForProfile('9.9.9.9:9999'); // 绑定了一个已不存在的租约
    expect(r.rotated).toBe(true);
    expect(r.lease?.server).toBe('1.2.3.4:1000');
  });

  it('在用全失效且无通道:提取新租约,rotated=true', async () => {
    stubQg({ inUse: [{ ...L1, deadline: '2020-01-01 00:00:00' }], extracted: L2 });
    const pool = new QgProxyPool('k');
    const r = await pool.acquireForProfile('1.2.3.4:1000');
    expect(r.lease?.server).toBe('5.6.7.8:2000');
    expect(r.rotated).toBe(true);
  });

  it('过期在用租约不认领(deadline 余量 10 分钟)', async () => {
    const soon = new Date(Date.now() + 5 * 60_000);
    const fmt = (d: Date) =>
      new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    stubQg({ inUse: [{ ...L1, deadline: fmt(soon) }], extracted: L2 });
    const pool = new QgProxyPool('k');
    const r = await pool.acquireForProfile(null);
    expect(r.lease?.server).toBe('5.6.7.8:2000'); // L1 即将到期,不认领
  });

  it('未启用(key 为空)直连降级:lease=null', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const pool = new QgProxyPool('');
    const r = await pool.acquireForProfile('1.2.3.4:1000');
    expect(r.lease).toBeNull();
    expect(r.rotated).toBe(false);
  });
});

describe('ProxyPoolManager 透传', () => {
  it('acquireForProfile 走到底层池', async () => {
    stubQg({ inUse: [L1] });
    const mgr = new ProxyPoolManager({}, 'k');
    const r = await mgr.acquireForProfile('1.2.3.4:1000');
    expect(r.lease?.server).toBe('1.2.3.4:1000');
  });
});
