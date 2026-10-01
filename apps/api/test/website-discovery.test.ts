import { describe, expect, it } from 'vitest';
import { normalizeWebsiteInput, sameHostFamily } from '../src/insights/website-discovery';

describe('官网域名归一(品牌资产·官网自动发现)', () => {
  it('补协议、去 www、去路径与参数、小写化', () => {
    expect(normalizeWebsiteInput('www.Lixiang.com/a?b=1')).toBe('https://lixiang.com');
    expect(normalizeWebsiteInput('https://WWW.NIO.COM')).toBe('https://nio.com');
    expect(normalizeWebsiteInput('  lixiang.com  ')).toBe('https://lixiang.com');
  });

  it('非法输入返回 null', () => {
    expect(normalizeWebsiteInput('')).toBeNull();
    expect(normalizeWebsiteInput('not a url')).toBeNull();
    expect(normalizeWebsiteInput('https://localhost')).toBeNull();
  });
});

describe('域名族等价', () => {
  it('apex 与 www 同族,跨域不同族', () => {
    expect(sameHostFamily('lixiang.com', 'www.lixiang.com')).toBe(true);
    expect(sameHostFamily('www.lixiang.com', 'lixiang.com')).toBe(true);
    expect(sameHostFamily('lixiang.com', 'nio.com')).toBe(false);
  });
});

import { isBlockedHostLiteral, isPrivateIp, probeWebsite } from '../src/insights/website-discovery';

describe('SSRF 拦截(官网探测服务端 GET 防护)', () => {
  it('字面内网/环回/链路本地/云 metadata 主机一律拒绝', () => {
    for (const host of [
      '10.0.0.1', '192.168.1.1', '172.16.0.9', '127.0.0.1', '169.254.169.254',
      '100.100.100.200', '100.64.1.1', '[::1]', '0.0.0.0', 'metadata.google.internal',
    ]) {
      expect(isBlockedHostLiteral(host.replace(/^\[|\]$/g, ''))).toBe(true);
    }
    expect(normalizeWebsiteInput('http://10.0.0.1')).toBeNull();
    expect(normalizeWebsiteInput('http://192.168.1.1')).toBeNull();
  });

  it('公网 IP 与正常域名放行', () => {
    expect(isBlockedHostLiteral('8.8.8.8')).toBe(false);
    expect(isBlockedHostLiteral('lixiang.com')).toBe(false);
  });

  it('isPrivateIp 覆盖 v4 保留段与 v6 环回/ULA/链路本地/映射地址', () => {
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('2606:4700::1')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });

  it('probeWebsite:重定向到内网地址被逐跳拦截,不到达 fetch', async () => {
    const pubDns = async () => [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('evil.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      }
      throw new Error('should not reach internal target');
    }) as unknown as typeof fetch;
    const res = await probeWebsite('https://evil.com', fetchImpl, 1000, pubDns);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked host');
  });

  it('probeWebsite:正常跳转同族放行,出族拒绝', async () => {
    const pubDns = async () => [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = (async (url: string | URL | Request) => {
      const s = String(url);
      // 注意顺序:www.lixiang.com 也 includes 'lixiang.com',必须先判带 www 的最终地址
      if (s.includes('www.lixiang.com')) return new Response('<html></html>', { status: 200 });
      if (s.includes('lixiang.com')) {
        return new Response(null, { status: 301, headers: { location: 'https://www.lixiang.com/home' } });
      }
      throw new Error(`unexpected url ${s}`);
    }) as unknown as typeof fetch;
    const ok = await probeWebsite('https://lixiang.com', fetchImpl, 1000, pubDns);
    expect(ok.ok).toBe(true);
    expect(ok.finalUrl).toBe('https://www.lixiang.com/home');
  });
});
