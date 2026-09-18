import { describe, expect, it } from 'vitest';
import { toAlipayTimestamp, toRfc3339Beijing } from '../src/billing/timeformat';

describe('支付渠道时间格式(北京时间语义)', () => {
  it('RFC3339:UTC 输入换算为东八区墙上时间并标注 +08:00', () => {
    // UTC 06:00 = 北京 14:00(旧实现把 Z 换成 +08:00 会得出 06:00+08:00,早 8 小时)
    expect(toRfc3339Beijing('2026-09-18T06:00:00.000Z')).toBe('2026-09-18T14:00:00+08:00');
  });

  it('RFC3339:跨日边界正确', () => {
    // UTC 2026-09-18 16:30 = 北京 2026-09-19 00:30
    expect(toRfc3339Beijing('2026-09-18T16:30:00.000Z')).toBe('2026-09-19T00:30:00+08:00');
  });

  it('RFC3339:接受 Date 入参,非法输入抛错', () => {
    expect(toRfc3339Beijing(new Date('2026-09-18T00:00:00.000Z'))).toBe('2026-09-18T08:00:00+08:00');
    expect(() => toRfc3339Beijing('not-a-date')).toThrow();
  });

  it('支付宝 timestamp:北京时间空格分隔', () => {
    expect(toAlipayTimestamp(new Date('2026-09-18T06:00:00.000Z'))).toBe('2026-09-18 14:00:00');
  });
});
