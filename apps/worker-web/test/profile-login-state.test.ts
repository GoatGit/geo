import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@geo/db';
import { AccountPoolService, type AcquiredProfile } from '../src/profiles';

const profile: AcquiredProfile = { id: 3, profileKey: 'profile:3', fingerprint: {}, proxyHint: null,
  proxyServer: null, contextRef: null, cookies: [], storageState: { cookies: [], origins: [] } };

/**
 * 行锁事务桩:withUnchangedCredentials 在 BEGIN 后 SELECT ... FOR UPDATE 读当前行,
 * 解密比对(测试无密钥=明文透传)一致才执行 UPDATE 并 COMMIT,否则 ROLLBACK。
 */
function txDb(row: { status: string; storage_state: unknown; cookies: unknown } | undefined) {
  const client = {
    query: vi.fn(async (sql: string) =>
      /for update/.test(sql) ? { rows: row ? [row] : [] } : { rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const db = { $client: { connect: async () => client } } as unknown as Db;
  return { db, client };
}

const matchingRow = () => ({
  status: 'available',
  storage_state: profile.storageState,
  cookies: profile.cookies,
});

describe('account login state persistence(loginVersion 防覆盖,行锁事务版)', () => {
  it('凭证未变时置 login_required:行锁内比对通过,UPDATE + COMMIT 执行', async () => {
    const { db, client } = txDb(matchingRow());
    await new AccountPoolService(db).markLoginRequired(profile);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('login_required'))).toBe(true);
    expect(sqls.some((s) => /commit/i.test(s))).toBe(true);
  });

  it('凭证未被并发重登覆盖时保存刷新:UPDATE 写入新登录态并 COMMIT', async () => {
    const { db, client } = txDb(matchingRow());
    const refreshed = { cookies: [], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: 'fresh' }] }] };
    await new AccountPoolService(db).saveStorageState(profile, refreshed);
    const update = client.query.mock.calls.find((c) => /update account_profiles set storage_state/.test(String(c[0])));
    expect(update).toBeTruthy();
    // 无密钥(测试环境)seal 透传明文,写入值即刷新后的登录态
    expect(update![1]).toEqual(expect.arrayContaining([JSON.stringify(refreshed), JSON.stringify(refreshed.cookies)]));
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /commit/i.test(s))).toBe(true);
  });

  it('凭证已被并发人工重登更新:不覆盖新凭证,ROLLBACK 且无 UPDATE', async () => {
    const { db, client } = txDb({
      status: 'available',
      storage_state: { cookies: [{ name: 'sid', value: 'newer-manual-login' }], origins: [] },
      cookies: [{ name: 'sid', value: 'newer-manual-login' }],
    });
    await new AccountPoolService(db).saveStorageState(profile, { cookies: [], origins: [] });
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /update account_profiles set storage_state/.test(s))).toBe(false);
    expect(sqls.some((s) => /rollback/i.test(s))).toBe(true);
  });

  it('档案行不存在(已被退役):不执行任何 UPDATE', async () => {
    const { db, client } = txDb(undefined);
    await new AccountPoolService(db).markLoginRequired(profile);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /update account_profiles set/.test(s))).toBe(false);
  });
});
