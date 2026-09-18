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

  it('布尔净化严格解析:字符串脏数据不得把 kill switch 重新打开', () => {
    // Boolean('false') === true 的松散转换曾让已停用的调度器被脏字符串重新启用
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: 'false' }]).schedulerEnabled).toBe(false);
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: false }]).schedulerEnabled).toBe(false);
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: 0 }]).schedulerEnabled).toBe(false);
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: 'true' }]).schedulerEnabled).toBe(true);
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: 1 }]).schedulerEnabled).toBe(true);
    // 完全不可解析的脏值回退默认(开),不静默半关
    expect(mergePlatformSettings([{ key: 'schedulerEnabled', value: 'oops' }]).schedulerEnabled).toBe(true);
  });

  it('负数与 NaN 引擎上限被剔除,小数向下取整', () => {
    const s = mergePlatformSettings([
      { key: 'engineDailyCaps', value: { doubao: 12.9, deepseek: -1, wenxin: Number.NaN, qwen: 0 } },
    ]);
    expect(s.engineDailyCaps).toEqual({ doubao: 12, qwen: 0 });
  });

  it('设置键集封口,新增键必须显式扩展', () => {
    // 精确键集封口:新增/删除设置键时此处必须显式同步,防止契约漂移
    expect([...PLATFORM_SETTING_KEYS].sort()).toEqual([
      'engineDailyCaps',
      'globalDailyRunCap',
      'proxyPool',
      'schedulerEnabled',
    ]);
  });
});
