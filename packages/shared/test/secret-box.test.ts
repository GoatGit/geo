import { describe, expect, it } from 'vitest';
import { isSealedSecret, parseCredentialKey, SecretBox } from '../src/secret-box';

const key = Buffer.alloc(32, 7);
const state = { cookies: [{ name: 'sid', value: 'abc' }], origins: [] };

describe('SecretBox(登录态静态加密)', () => {
  it('密钥解析:hex 64 位与 base64 32 字节皆可,非法返回 null', () => {
    expect(parseCredentialKey('ab'.repeat(32))).toHaveLength(32);
    expect(parseCredentialKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
    expect(parseCredentialKey('too-short')).toBeNull();
    expect(parseCredentialKey(undefined)).toBeNull();
  });

  it('密封后不可辨识原值,解封还原;每次密封 IV 随机(密文不同)', () => {
    const box = new SecretBox(key, false);
    const sealed = box.seal(state);
    expect(isSealedSecret(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('sid');
    expect(box.open<typeof state>(sealed)).toEqual(state);
    expect(box.seal(state)).not.toEqual(sealed);
  });

  it('null/undefined 原样透传(无登录态的 mock 档案)', () => {
    const box = new SecretBox(key, false);
    expect(box.seal(null)).toBeNull();
    expect(box.open(null)).toBeNull();
    expect(box.open(undefined)).toBeNull();
  });

  it('历史明文行 open 原样返回(透明兼容,不抛错)', () => {
    const box = new SecretBox(key, false);
    expect(box.open<typeof state>(state)).toEqual(state);
  });

  it('未配密钥:非生产 seal 透传并兼容明文;生产 seal 抛错但 open 明文仍可用', () => {
    const dev = new SecretBox(null, false);
    expect(dev.seal(state)).toBe(state);
    const prod = new SecretBox(null, true);
    expect(() => prod.seal(state)).toThrow(/CREDENTIAL_ENC_KEY/);
    expect(prod.open(state)).toEqual(state);
  });

  it('密文被篡改时解封抛错(GCM 认证),而非返回垃圾', () => {
    const box = new SecretBox(key, false);
    const sealed = { ...(box.seal(state) as ReturnType<SecretBox['seal']>) };
    sealed.ct = sealed.ct.slice(0, -4) + 'AAAA';
    expect(() => box.open(sealed)).toThrow();
  });

  it('密钥错配时解封抛错(提示密钥丢失),不静默返回', () => {
    const sealed = new SecretBox(key, false).seal(state);
    const wrong = new SecretBox(Buffer.alloc(32, 9), false);
    expect(() => wrong.open(sealed)).toThrow();
  });
});
