import { describe, expect, it } from 'vitest';
import { nextRunAtFrom, tzOffsetMs } from '../src/scheduler';

/** 读取某时刻在指定时区的墙钟分量。 */
function wallParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

describe('tzOffsetMs(时区偏移)', () => {
  it('Asia/Shanghai 恒为 +8h(无夏令时)', () => {
    expect(tzOffsetMs(new Date('2026-01-15T00:00:00Z'), 'Asia/Shanghai')).toBe(8 * 3600_000);
    expect(tzOffsetMs(new Date('2026-07-15T00:00:00Z'), 'Asia/Shanghai')).toBe(8 * 3600_000);
  });

  it('纽约夏令时 -4h、冬季 -5h', () => {
    expect(tzOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3600_000);
    expect(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3600_000);
  });

  it('非法时区回落 +8h 不抛错', () => {
    expect(tzOffsetMs(new Date(), 'Mars/Olympus')).toBe(8 * 3600_000);
  });
});

describe('nextRunAtFrom(docs/04 §3.4 次日品牌时区白天随机)', () => {
  const rand = () => 0; // 固定随机源:小时=10、分钟=0

  it('上海品牌:次日 10:00–15:59 之间(UTC+8 墙钟)', () => {
    const now = new Date('2026-09-14T03:00:00Z'); // 上海 11:00
    for (let s = 0; s < 20; s++) {
      const next = nextRunAtFrom(now, 'Asia/Shanghai');
      const w = wallParts(next, 'Asia/Shanghai');
      expect(w.date).toBe('2026-9-15');
      expect(w.hour).toBeGreaterThanOrEqual(10);
      expect(w.hour).toBeLessThanOrEqual(15);
    }
  });

  it('注入随机源时结果确定(10:00 整)', () => {
    const now = new Date('2026-09-14T03:00:00Z');
    const next = nextRunAtFrom(now, 'Asia/Shanghai', rand);
    expect(wallParts(next, 'Asia/Shanghai')).toMatchObject({ date: '2026-9-15', hour: 10, minute: 0 });
  });

  it('纽约品牌落在纽约时区的次日白天,而非上海白天', () => {
    const now = new Date('2026-07-14T03:00:00Z'); // 纽约 7-13 23:00(EDT)→ 次日 = 7-14
    const next = nextRunAtFrom(now, 'America/New_York', rand);
    const w = wallParts(next, 'America/New_York');
    expect(w.date).toBe('2026-7-14');
    expect(w.hour).toBe(10);
    // 纽约 10:00(EDT)= UTC 14:00
    expect(next.toISOString()).toBe('2026-07-14T14:00:00.000Z');
  });

  it('结果总是晚于 now(不会把计划排进过去)', () => {
    const now = new Date('2026-09-14T15:59:00Z');
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/London']) {
      expect(nextRunAtFrom(now, tz).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
