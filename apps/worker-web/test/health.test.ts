import { describe, expect, it } from 'vitest';
import { nextHealthAction, DAILY_QUOTA_PER_PROFILE } from '../src/profiles';
import { isPlausibleEntityName } from '../src/extraction';

describe('nextHealthAction(docs/04 §3.2 健康分迁移)', () => {
  it('≤30 退役', () => {
    expect(nextHealthAction(0)).toBe('retire');
    expect(nextHealthAction(30)).toBe('retire');
  });

  it('<60 冷却(31-59),≥60 保持可用', () => {
    expect(nextHealthAction(31)).toBe('cooldown');
    expect(nextHealthAction(59)).toBe('cooldown');
    expect(nextHealthAction(60)).toBe('keep');
    expect(nextHealthAction(100)).toBe('keep');
  });

  it('单账号日配额 = 20(docs/04 §3.2 配额内化)', () => {
    expect(DAILY_QUOTA_PER_PROFILE).toBe(20);
  });
});

describe('isPlausibleEntityName(docs/05 §3.3 竞品候选噪声过滤)', () => {
  it('正常品牌名通过', () => {
    expect(isPlausibleEntityName('比亚迪')).toBe(true);
    expect(isPlausibleEntityName('Tesla Model Y')).toBe(true);
  });

  it('过长/过短/含标点的描述行被过滤', () => {
    expect(isPlausibleEntityName('a')).toBe(false);
    expect(isPlausibleEntityName('这是一句特别特别特别长的描述显然不是品牌实体名称')).toBe(false);
    expect(isPlausibleEntityName('比亚迪:好车')).toBe(false);
    expect(isPlausibleEntityName('性能,续航')).toBe(false);
  });
});
