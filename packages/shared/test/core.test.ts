import { describe, expect, it } from 'vitest';
import {
  QUERY_RUN_STATUSES,
  PLAN_LIMITS,
  countsTowardsDenominator,
  isWebEngine,
} from '../src';

describe('QueryRun 四态状态机(docs/02 §1.1)', () => {
  it('分母只计 ok_with_answer 与 ok_empty;failed/quota_blocked 不进分母', () => {
    expect(countsTowardsDenominator('ok_with_answer')).toBe(true);
    expect(countsTowardsDenominator('ok_empty')).toBe(true);
    expect(countsTowardsDenominator('failed')).toBe(false);
    expect(countsTowardsDenominator('quota_blocked')).toBe(false);
  });

  it('状态全集封口,防漏态', () => {
    expect(QUERY_RUN_STATUSES).toHaveLength(4);
  });
});

describe('套餐门控矩阵(docs/01 §3.10)', () => {
  it('免费版:3+1 题/3 引擎/无导出/无报告;标准起有月报', () => {
    expect(PLAN_LIMITS.free).toMatchObject({
      rankingQuota: 3,
      reputationQuota: 1,
      webEngines: 3,
      exportAllowed: false,
      weeklyReport: false,
    });
    expect(PLAN_LIMITS.standard.monthlyReport).toBe(true);
    expect(PLAN_LIMITS.pro.multiBrand).toBe(5);
    expect(PLAN_LIMITS.custom.apiAccess).toBe(true);
  });

  it('历史趋势窗口递增(docs/01 §3.10)', () => {
    expect(PLAN_LIMITS.free.historyDays).toBeLessThan(PLAN_LIMITS.starter.historyDays);
    expect(PLAN_LIMITS.starter.historyDays).toBeLessThan(PLAN_LIMITS.standard.historyDays);
    expect(PLAN_LIMITS.standard.historyDays).toBeLessThan(PLAN_LIMITS.pro.historyDays);
  });
});

describe('引擎清单', () => {
  it('网页端 5 引擎(docs/00 §2)', () => {
    expect(isWebEngine('doubao')).toBe(true);
    expect(isWebEngine('gpt')).toBe(false);
  });
});
