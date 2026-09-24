import { describe, expect, it } from 'vitest';
import { SHARE_TTL_DAYS, signShareToken, verifyShareToken } from '../src/reports/share-token';

describe('报告分享 token(docs/01 §3.8 分享链接)', () => {
  const secret = 'test-secret';
  const exp = Date.now() + 1000;

  it('签发后可校验通过;绑定报告 id,换 id 即失效', () => {
    const token = signShareToken(42, exp, secret);
    expect(verifyShareToken(42, token, secret)).toBe(true);
    expect(verifyShareToken(43, token, secret)).toBe(false);
  });

  it('过期 token 拒绝', () => {
    const token = signShareToken(42, Date.now() - 1000, secret);
    expect(verifyShareToken(42, token, secret)).toBe(false);
  });

  it('伪造/篡改 token 拒绝', () => {
    const token = signShareToken(42, exp, secret);
    expect(verifyShareToken(42, `${token}0`, secret)).toBe(false);
    expect(verifyShareToken(42, `9999999999999.${'a'.repeat(64)}`, secret)).toBe(false);
    expect(verifyShareToken(42, 'garbage', secret)).toBe(false);
    expect(verifyShareToken(42, '', secret)).toBe(false);
  });

  it('换密钥后旧 token 失效(密钥轮换语义)', () => {
    const token = signShareToken(42, exp, secret);
    expect(verifyShareToken(42, token, 'another-secret')).toBe(false);
  });

  it('TTL 常量为 180 天', () => {
    expect(SHARE_TTL_DAYS).toBe(180);
  });
});
