/**
 * 官网自动发现的验证层:LLM 只出候选,这里负责"格式归一 + 可达性探测 + 域名族校验",
 * 宁缺毋滥——验证不过一律不落库(防幻觉域名污染官网被引维度)。
 */

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
  return `https://${host.replace(/^www\./, '')}`;
}

/** 域名族等价:apex 与 www 互为同族(lixiang.com ↔ www.lixiang.com)。 */
export function sameHostFamily(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/^www\./, '');
  const nb = b.toLowerCase().replace(/^www\./, '');
  return na === nb || na === `www.${nb}` || nb === `www.${na}`;
}

const PROBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface ProbeResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  error?: string;
}

/** 探测候选官网:GET 跟随重定向;<400 且最终域名不出族才算可达。 */
export async function probeWebsite(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': PROBE_UA, accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : 'network error' };
  }
  if (res.status >= 400) return { ok: false, status: res.status, finalUrl: res.url || url };
  try {
    const finalHost = new URL(res.url || url).hostname;
    if (!sameHostFamily(finalHost, new URL(url).hostname)) {
      return { ok: false, status: res.status, finalUrl: res.url, error: 'redirected off-domain' };
    }
  } catch {
    // final URL 解析失败不阻断
  }
  return { ok: true, status: res.status, finalUrl: res.url || url };
}
