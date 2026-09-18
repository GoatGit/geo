import { describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/admin.controller';
import type { Request } from 'express';

function controller() {
  const commands: string[] = [];
  const redis = {
    get: vi.fn(async () => JSON.stringify({ state: 'running', viewer: true })),
    lpush: vi.fn(async (_key: string, value: string) => commands.unshift(value)),
    rpush: vi.fn(async (_key: string, value: string) => commands.push(value)),
    expire: vi.fn(async () => 1),
  };
  // Avoid creating unrelated BullMQ connections in this controller unit test.
  const c = Object.assign(Object.create(AdminController.prototype), { redis }) as AdminController;
  return { c, redis, commands };
}

describe('remote login input', () => {
  it('keeps click and typing in arrival order', async () => {
    const { c, commands } = controller();
    await c.loginInput('session', { type: 'click', x: 50, y: 20 });
    await c.loginInput('session', { type: 'type', text: '123' });
    expect(commands.map((cmd) => JSON.parse(cmd).type)).toEqual(['click', 'type']);
  });

  it('rejects input to a completed session', async () => {
    const { c, redis, commands } = controller();
    redis.get.mockResolvedValue(JSON.stringify({ state: 'done', viewer: true }));
    await expect(c.loginInput('session', { type: 'type', text: '123' })).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });

  it('rejects nonfinite pointer coordinates', async () => {
    const { c } = controller();
    await expect(c.loginInput('session', { type: 'click', x: Infinity, y: 0 })).rejects.toThrow();
  });

  it('reuses an active login session instead of opening a second browser', async () => {
    const profile = { id: 1, engine: 'doubao', status: 'pending_login', fingerprint: {} };
    const redis = { status: 'ready', set: vi.fn(async () => null), get: vi.fn(async () => 'existing-session') };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [profile] }) }) }) };
    const c = Object.assign(Object.create(AdminController.prototype), { redis, db }) as AdminController;
    const req = { account: { accountId: 1, phone: 'test' } } as Request;
    expect((await c.requestLogin(req, 1)).sessionId).toBe('existing-session');
  });
});
