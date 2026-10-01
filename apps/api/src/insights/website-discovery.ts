/**
 * 官网自动发现的验证层:LLM 只出候选,这里负责"格式归一 + 内网拦截 + 可达性探测 + 域名族校验",
 * 宁缺毋滥——验证不过一律不落库(防幻觉域名污染官网被引维度)。
 * SSRF 防护:候选来自用户可诱导的 LLM 输出,探测前必须拦截字面内网 IP 与
 * 解析到内网的域名,重定向逐跳复检(redirect:'follow' 会在检查生效前就打到内网)。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function normalizeWebsiteInput(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    const u = new URL(s);
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host) || !host.includes('.')) return null;
  if (isBlockedHostLiteral(host)) return null;
  return `https://${host.replace(/^www\./, '')}`;
}

/** 域名族等价:apex 与 www 互为同族(lixiang.com ↔ www.lixiang.com)。 */
export function sameHostFamily(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/^www\./, '');
  const nb = b.toLowerCase().replace(/^www\./, '');
  return na === nb || na === `www.${nb}` || nb === `www.${na}`;
}

/** 云 metadata / 常见内网服务域名(数字 IP 由 isBlockedHostLiteral 覆盖)。 */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'instance-data',
  '100.100.100.200', // 阿里云 metadata
]);

function ipv4ToLong(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

/** 保留/不可路由地址:环回、私网、链路本地(含云 metadata 169.254.169.254)、CGNAT、组播/保留段。 */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    return (
      inCidr4(ip, '0.0.0.0', 8) ||
      inCidr4(ip, '10.0.0.0', 8) ||
      inCidr4(ip, '100.64.0.0', 10) ||
      inCidr4(ip, '127.0.0.0', 8) ||
      inCidr4(ip, '169.254.0.0', 16) ||
      inCidr4(ip, '172.16.0.0', 12) ||
      inCidr4(ip, '192.0.0.0', 24) ||
      inCidr4(ip, '192.168.0.0', 16) ||
      inCidr4(ip, '198.18.0.0', 15) ||
      inCidr4(ip, '224.0.0.0', 3)
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;
    // IPv4-mapped (::ffff:10.0.0.1) 与私网 fc00::/7、链路本地 fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateIp(mapped[1]!);
    return low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb');
  }
  return true; // 不是合法 IP 一律按不可信处理
}

/** 字面 IP 主机拦截:normalizeWebsiteInput 与重定向逐跳都走这里。 */
export function isBlockedHostLiteral(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  // 纯数字+点(10.0.0.1)不是合法域名;合法 IP 交给 isPrivateIp 判保留段
  const v = isIP(host);
  if (v !== 0) return isPrivateIp(host);
  return /^\d+(\.\d+)*$/.test(host);
}

/**
 * 域名解析后逐地址校验:字面检查可被 DNS 记录绕过(域名解析到 169.254.169.254)。
 * 任一地址私网即拒绝(不放过混解析)。lookupImpl 可注入,测试不打真实 DNS。
 */
export async function isPublicHost(
  host: string,
  lookupImpl: (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>> = lookup,
): Promise<boolean> {
  if (isBlockedHostLiteral(host)) return false;
  try {
    const addrs = await lookupImpl(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

const PROBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface ProbeResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  error?: string;
}

const MAX_REDIRECTS = 3;

/** 探测候选官网:GET 手动逐跳跟随重定向(每跳内网拦截);<400 且最终域名不出族才算可达。 */
export async function probeWebsite(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
  lookupImpl?: Parameters<typeof isPublicHost>[1],
): Promise<ProbeResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let host: string;
    try {
      host = new URL(current).hostname.toLowerCase();
    } catch {
      return { ok: false, error: 'invalid url' };
    }
    if (!(await isPublicHost(host, ...(lookupImpl ? [lookupImpl] : [])))) return { ok: false, error: 'blocked host' };
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': PROBE_UA, accept: 'text/html,application/xhtml+xml' },
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : 'network error' };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status, error: 'redirect without location' };
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { ok: false, status: res.status, error: 'invalid redirect target' };
      }
      continue;
    }
    if (res.status >= 400) return { ok: false, status: res.status, finalUrl: current };
    try {
      const finalHost = new URL(current).hostname;
      if (!sameHostFamily(finalHost, new URL(url).hostname)) {
        return { ok: false, status: res.status, finalUrl: current, error: 'redirected off-domain' };
      }
    } catch {
      // final URL 解析失败不阻断
    }
    return { ok: true, status: res.status, finalUrl: current };
  }
  return { ok: false, error: 'too many redirects' };
}
