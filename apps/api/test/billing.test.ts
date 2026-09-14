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

  it('多笔叠加取最高档位,过期时间取该档位最晚', () => {
    const r = resolveMembership(
      [
        { plan: 'starter', period: 'yearly', paidAt: new Date('2026-09-01T00:00:00Z') },
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-09-10T00:00:00Z') },
        { plan: 'standard', period: 'monthly', paidAt: new Date('2026-09-13T00:00:00Z') },
      ],
      now,
    );
    expect(r.plan).toBe('standard');
    expect(r.expiresAt!.toISOString()).toBe('2026-10-13T00:00:00.000Z');
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
