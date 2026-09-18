import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@geo/db';
import { AccountPoolService, type AcquiredProfile } from '../src/profiles';

const profile: AcquiredProfile = { id: 3, profileKey: 'profile:3', fingerprint: {}, proxyHint: null,
  proxyServer: null, contextRef: null, cookies: [], storageState: { cookies: [], origins: [] } };

describe('account login state persistence', () => {
  it('retains credentials when collection requests manual login', async () => {
    const set = vi.fn(() => ({ where: vi.fn() }));
    const pool = new AccountPoolService({ update: () => ({ set }) } as unknown as Db);
    await pool.markLoginRequired(profile);
    expect(set).toHaveBeenCalledWith({ status: 'login_required', cooldownUntil: null });
  });

  it('only refreshes the same credential version while the profile is still available', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = new AccountPoolService({ $client: { query } } as unknown as Db);
    const refreshed = { cookies: [], origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: 'fresh' }] }] };
    await pool.saveStorageState(profile, refreshed);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'available'"), [
      JSON.stringify(refreshed), JSON.stringify(refreshed.cookies), profile.id,
      JSON.stringify(profile.storageState), JSON.stringify(profile.cookies),
    ]);
    expect(query.mock.calls[0]![0]).toContain('storage_state is not distinct from');
  });
});
