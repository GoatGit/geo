import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTING_KEYS,
  mergePlatformSettings,
} from '../src';

describe('平台配置净化(管理后台 ↔ 调度器契约)', () => {
  it('空存储回退默认值:调度开、不限量', () => {
    expect(mergePlatformSettings([])).toEqual(DEFAULT_PLATFORM_SETTINGS);
  });

  it('接受 db 行数组形态(key-value)', () => {
    const s = mergePlatformSettings([
      { key: 'schedulerEnabled', value: false },
      { key: 'globalDailyRunCap', value: 500 },
      { key: 'engineDailyCaps', value: { doubao: 100 } },
    ]);
    expect(s.schedulerEnabled).toBe(false);
    expect(s.globalDailyRunCap).toBe(500);
    expect(s.engineDailyCaps.doubao).toBe(100);
  });

  it('脏数据不致命:非法数值与对象回退安全形态', () => {
    const s = mergePlatformSettings([
      { key: 'globalDailyRunCap', value: -3 },
      { key: 'engineDailyCaps', value: 'oops' },
      { key: 'schedulerEnabled', value: 0 },
    ]);
    expect(s.globalDailyRunCap).toBe(0);
    expect(s.engineDailyCaps).toEqual({});
    expect(s.schedulerEnabled).toBe(false); // 0 是合法的显式停用
  });

  it('负数与 NaN 引擎上限被剔除,小数向下取整', () => {
    const s = mergePlatformSettings([
      { key: 'engineDailyCaps', value: { doubao: 12.9, deepseek: -1, wenxin: Number.NaN, qwen: 0 } },
    ]);
    expect(s.engineDailyCaps).toEqual({ doubao: 12, qwen: 0 });
  });

  it('设置键集封口,新增键必须显式扩展', () => {
    expect(PLATFORM_SETTING_KEYS).toHaveLength(3);
  });
});
