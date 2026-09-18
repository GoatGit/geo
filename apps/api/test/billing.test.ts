import { describe, expect, it } from 'vitest';
import { nextPeriodEnd, resolveMembership } from '../src/billing/billing.service';

/** 会员有效期与档位解析(docs/02 §7):多笔叠加取最高档、过期窗口、续费顺延不缩水。 */
describe('billing membership', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('无有效订单 → free', () => {
    const r = resolveMembership([], now);
    expect(r.plan).toBe('free');
    expect(r.expiresAt).toBeNull();
  });

  it('过期订单不计入', () => {
    const r = resolveMembership([{ plan: 'pro', period: 'monthly', paidAt: new Date('2026-06-01T00:00:00Z') }], now);
    expect(r.plan).toBe('free');
  });

  it('多笔叠加取最高档位,同档续费链式顺延', () => {
    const r = resolveMembership(
      [
        { plan: 'starter', period: 'yearly', paidAt: new Date('2026-09-01T00:00:00Z') },
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-09-10T00:00:00Z') },
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-09-13T00:00:00Z') },
      ],
      now,
    );
    expect(r.plan).toBe('standard');
    // 9/10 月付 → 10/10;9/13 再买:未过期从 10/10 顺延 → 11/9(而非独立开窗的 10/13)
    expect(r.expiresAt!.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('提前续费与订阅行同口径:9/1 月付 + 9/10 续费 = 10/31(曾只算到 10/10,已付费权益缩水)', () => {
    const r = resolveMembership(
      [
        { plan: 'pro', period: 'monthly', paidAt: new Date('2026-09-01T00:00:00Z') },
        { plan: 'pro', period: 'monthly', paidAt: new Date('2026-09-10T00:00:00Z') },
      ],
      now,
    );
    expect(r.plan).toBe('pro');
    expect(r.expiresAt!.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    // 与订阅行顺延算法完全一致
    expect(nextPeriodEnd(new Date('2026-10-01T00:00:00Z'), 'monthly', now).toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });

  it('过期后续费从购买时间起算(续费链不把已过期窗口累加进来)', () => {
    const r = resolveMembership(
      [
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-06-01T00:00:00Z') }, // 7/1 已过期
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-09-10T00:00:00Z') },
      ],
      now,
    );
    expect(r.expiresAt!.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('高档位过期后回落到仍在期的低档位', () => {
    const r = resolveMembership(
      [
        { plan: 'pro', period: 'monthly', paidAt: new Date('2026-06-01T00:00:00Z') }, // 已过期
        { plan: 'starter', period: 'monthly', paidAt: new Date('2026-09-10T00:00:00Z') },
      ],
      now,
    );
    expect(r.plan).toBe('starter');
  });

  it('年付窗口 365 天,月付 30 天', () => {
    const r = resolveMembership([{ plan: 'pro', period: 'yearly', paidAt: now }], now);
    expect(r.expiresAt!.toISOString()).toBe('2027-09-14T00:00:00.000Z');
    const m = resolveMembership([{ plan: 'pro', period: 'monthly', paidAt: now }], now);
    expect(m.expiresAt!.toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });

  it('续费顺延:未过期从现有到期日上加,已过期从当前时间起算', () => {
    const active = nextPeriodEnd(new Date('2026-09-20T00:00:00Z'), 'monthly', now);
    expect(active.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    const expired = nextPeriodEnd(new Date('2026-08-01T00:00:00Z'), 'monthly', now);
    expect(expired.toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });
});
