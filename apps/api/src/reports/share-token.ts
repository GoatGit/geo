import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 报告分享链接签名(docs/01 §3.8 扩展):HMAC-SHA256(id + 过期时间, 服务端密钥),
 * 无状态——不落库、不可伪造、只对单个报告有效;过期后链接自然失效。
 * 密钥复用 JWT access secret(同源轮换;泄漏面一致)。
 */
export const SHARE_TTL_DAYS = 180;

export function signShareToken(reportId: number, expMs: number, secret: string): string {
  const mac = createHmac('sha256', secret).update(`${reportId}.${expMs}`).digest('hex');
  return `${expMs}.${mac}`;
}

/** 校验分享 token;过期/签名不符/格式非法返回 false。 */
export function verifyShareToken(reportId: number, token: string, secret: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d{13}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const exp = Number(expStr);
  if (exp < now) return false;
  const expected = createHmac('sha256', secret).update(`${reportId}.${exp}`).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
