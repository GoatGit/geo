import { describe, expect, it } from 'vitest';
import { nextRunAtFrom, planRoundJobs, tzOffsetMs, type Budget } from '../src/scheduler';

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

describe('nextRunAtFrom(docs/04 §3.4 次日品牌时区白天随机,距 now ≥ 24h)', () => {
  const rand = () => 0; // 固定随机源:取可用窗口的起点

  it('上海品牌:次日白天窗口内(UTC+8 墙钟),随机 20 次全部满足', () => {
    const now = new Date('2026-09-14T03:00:00Z'); // 上海 11:00
    for (let s = 0; s < 20; s++) {
      const next = nextRunAtFrom(now, 'Asia/Shanghai');
      const w = wallParts(next, 'Asia/Shanghai');
      expect(w.date).toBe('2026-9-15');
      expect(w.hour).toBeGreaterThanOrEqual(10);
      expect(w.hour).toBeLessThanOrEqual(15);
    }
  });

  it('注入随机源时结果确定:窗口起点被 24h 下限截断到 11:00(9-14 11:00 派发,10:00 仅 23h 不合法)', () => {
    const now = new Date('2026-09-14T03:00:00Z');
    const next = nextRunAtFrom(now, 'Asia/Shanghai', rand);
    expect(wallParts(next, 'Asia/Shanghai')).toMatchObject({ date: '2026-9-15', hour: 11, minute: 0 });
    expect(next.toISOString()).toBe('2026-09-15T03:00:00.000Z');
  });

  it('纽约品牌落在纽约时区的白天,且晚于 now+24h(候选日窗口整段早于下限时顺延一天)', () => {
    const now = new Date('2026-07-14T03:00:00Z'); // 纽约 7-13 23:00(EDT)
    const next = nextRunAtFrom(now, 'America/New_York', rand);
    const w = wallParts(next, 'America/New_York');
    expect(w.date).toBe('2026-7-15');
    expect(w.hour).toBe(10);
    // 纽约 7-15 10:00(EDT)= UTC 14:00;7-14 的窗口整段早于 now+24h(7-15 03:00Z),不得使用
    expect(next.toISOString()).toBe('2026-07-15T14:00:00.000Z');
  });

  it('晚间派发(上海 23:30):次日窗口距 now 不足 24h,顺延到第三日白天', () => {
    const now = new Date('2026-09-14T15:30:00Z'); // 上海 23:30
    const next = nextRunAtFrom(now, 'Asia/Shanghai', rand);
    const w = wallParts(next, 'Asia/Shanghai');
    expect(w.date).toBe('2026-9-16');
    expect(w.hour).toBe(10);
    expect(next.getTime() - now.getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
  });

  it('任意时区与随机源:结果总是晚于 now 且距 now ≥ 24h', () => {
    const now = new Date('2026-09-14T15:59:00Z');
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/London']) {
      for (let s = 0; s < 50; s++) {
        const t = nextRunAtFrom(now, tz).getTime();
        expect(t).toBeGreaterThan(now.getTime());
        expect(t - now.getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
      }
    }
  });
});

describe('planRoundJobs(轮次入队计划:全局 + 每引擎预算逐任务复查)', () => {
  const questions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

  const budgetOf = (globalRemaining: number, engines: Record<string, number>): Budget => ({
    globalRemaining,
    engineRemaining: new Map(Object.entries(engines).map(([k, v]) => [k, v])),
  });

  it('引擎余量 1、题目 3:该引擎只派 1 个,余量归零不为负', () => {
    const budget = budgetOf(Infinity, { doubao: 1, deepseek: 100 });
    const jobs = planRoundJobs(questions(3), ['doubao', 'deepseek'], budget);
    expect(jobs.filter((j) => j.engine === 'doubao')).toHaveLength(1);
    expect(jobs.filter((j) => j.engine === 'deepseek')).toHaveLength(3);
    expect(budget.engineRemaining.get('doubao')).toBe(0);
    expect(budget.engineRemaining.get('deepseek')).toBe(97);
  });

  it('全局预算截断优先:全局 2、2 引擎×3 题 → 只入队 2 个', () => {
    const budget = budgetOf(2, { doubao: 10, deepseek: 10 });
    const jobs = planRoundJobs(questions(3), ['doubao', 'deepseek'], budget);
    expect(jobs).toHaveLength(2);
    expect(budget.globalRemaining).toBe(2 - 0); // 全局由调用方按入队数扣减,计划器不改动
  });

  it('余量为 0 的引擎被跳过,不产生负账', () => {
    const budget = budgetOf(Infinity, { doubao: 0, deepseek: 2 });
    const jobs = planRoundJobs(questions(2), ['doubao', 'deepseek'], budget);
    expect(jobs.map((j) => j.engine)).toEqual(['deepseek', 'deepseek']);
  });

  it('无限额度(Infinity)不受影响:全部入队', () => {
    const budget = budgetOf(Infinity, { doubao: Number.POSITIVE_INFINITY });
    const jobs = planRoundJobs(questions(5), ['doubao'], budget);
    expect(jobs).toHaveLength(5);
  });
});
