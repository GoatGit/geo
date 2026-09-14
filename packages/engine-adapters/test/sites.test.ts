import { describe, expect, it } from 'vitest';
import { WEB_ENGINES } from '@geo/shared';
import { ENGINE_SITES, DomWebAdapter, WEB_ADAPTER_SCHEMA_VERSION, needsLoginOf } from '../src';

describe('五引擎站点配置(docs/04 §2.1 真实 DOM 采集,实测校准)', () => {
  it('五个引擎均有完整站点配置,登录判定与选择器链非空', () => {
    for (const engine of WEB_ENGINES) {
      const site = ENGINE_SITES[engine];
      expect(site.chatUrl.startsWith('https://'), `${engine} chatUrl 必须 https`).toBe(true);
      // 登录判定:按钮指示与 URL 模式至少其一(2026-09 实测:deepseek/wenxin 仅 URL 判定可靠)
      expect(site.loginHints.length + site.loginUrlPatterns.length).toBeGreaterThan(0);
      expect(site.inputSelectors.length).toBeGreaterThan(0);
      expect(site.answerSelectors.length).toBeGreaterThan(0);
      expect(site.completionStableMs).toBeGreaterThan(0);
      expect(site.navigationTimeoutMs).toBeGreaterThan(0);
    }
  });

  it('实测校准快照(2026-09):重定向与游客采集形态', () => {
    // tongyi.com → qianwen.com(品牌升级);wenxin 游客可直接提问,登录按钮非门槛
    expect(ENGINE_SITES.qwen.chatUrl).toContain('qianwen.com');
    expect(ENGINE_SITES.wenxin.chatUrl).toContain('wenxin.baidu.com');
    expect(ENGINE_SITES.wenxin.loginHints).toEqual([]);
    // deepseek 未登录强制跳 /sign_in,以 URL 判定
    expect(ENGINE_SITES.deepseek.loginUrlPatterns).toContain('sign_in');
  });

  it('引擎覆盖:豆包/DeepSeek/文心/通义/元宝一一对应', () => {
    expect(Object.keys(ENGINE_SITES).sort()).toEqual([...WEB_ENGINES].sort());
  });

  it('DOM 适配器带版本化 schema(页面改版可升版本,docs/04 §2)', () => {
    const adapter = new DomWebAdapter('doubao');
    expect(adapter.schemaVersion).toBe(WEB_ADAPTER_SCHEMA_VERSION);
    expect(adapter.strategy).toBe('dom');
    expect(adapter.surface).toBe('web');
  });

  it('needs_login 结果可被识别(账号置 login_required 的依据)', () => {
    expect(
      needsLoginOf({
        status: 'failed',
        answerText: '',
        rawHtml: null,
        citations: [],
        timing: { queuedAt: '', firstTokenAt: '', completedAt: '' },
        engineMeta: { needsLogin: true },
      }),
    ).toBe(true);
    expect(needsLoginOf({ status: 'failed', answerText: '', rawHtml: null, citations: [], timing: { queuedAt: '', firstTokenAt: '', completedAt: '' } })).toBe(false);
  });
});
