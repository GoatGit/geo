import { describe, expect, it } from 'vitest';
import { WEB_ENGINES } from '@geo/shared';
import { ENGINE_SITES, DomWebAdapter, WEB_ADAPTER_SCHEMA_VERSION, needsLoginOf, siteConfigOf, stripAnswerNoise } from '../src';

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

  it('页面 UI 噪声清洗:元宝 banner/功能栏/引用截断 + 千问引号回显(线上 run#7289 实测)', () => {
    const site = siteConfigOf('yuanbao');
    const raw = [
      '一站式解决办公学习需求',
      'Hy4 preview模型，AI搜索信源更准更全',
      '安装元宝电脑版',
      '理想汽车的口碑和质量到底怎么样?有什么优缺点?',
      '理想汽车的口碑呈现明显的"双轨分化":家庭用户满意度很高。',
      '快速回答 AI 生图 写作 解题 深度研究 PPT 生成 数据分析',
      '引用来源(10)',
      'https://hao.yiche.com/wenzhang/112777065 理想L6 - 投诉',
    ].join('\n');
    const cleaned = stripAnswerNoise(site, raw);
    expect(cleaned).not.toContain('一站式');
    expect(cleaned).not.toContain('Hy4');
    expect(cleaned).not.toContain('安装元宝');
    expect(cleaned).not.toContain('AI 生图');
    expect(cleaned).not.toContain('yiche.com');
    expect(cleaned).toContain('双轨分化');
    expect(cleaned.split('\n')[0]).toContain('理想汽车的口碑和质量');
    const q = stripAnswerNoise(siteConfigOf('qwen'), '"理想L9车主真实评价"\n该车型口碑出色。');
    expect(q).toContain('口碑出色');
    expect(q).not.toContain('理想L9车主真实评价');
  });
});
