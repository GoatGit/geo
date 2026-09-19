import { describe, expect, it } from 'vitest';
import { InsightAgent } from '../src';
import { validateWebsiteOutput } from '../src/schema';
import { DEFAULT_INSIGHT_AGENT_SETTINGS, type InsightAgentSettings } from '@geo/shared';

const llmSettings = (over: Partial<InsightAgentSettings> = {}): InsightAgentSettings => ({
  ...DEFAULT_INSIGHT_AGENT_SETTINGS,
  enabled: true,
  mode: 'llm',
  endpoint: 'https://llm.example.com/v1',
  apiKey: 'sk-test',
  model: 'qwen-max',
  ...over,
});

describe('validateWebsiteOutput', () => {
  it('合法 URL 接受并钳制 confidence', () => {
    const r = validateWebsiteOutput({ url: 'https://www.lixiang.com/', confidence: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://www.lixiang.com/', confidence: 1 });
  });

  it('url=null(不知道)合法', () => {
    const r = validateWebsiteOutput({ url: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toBeNull();
  });

  it('非 http 形态拒绝', () => {
    expect(validateWebsiteOutput({ url: 'lixiang.com' }).ok).toBe(false);
    expect(validateWebsiteOutput({ url: '随便说说' }).ok).toBe(false);
  });

  it('非对象根拒绝', () => {
    expect(validateWebsiteOutput('https://x.com').ok).toBe(false);
  });
});

describe('suggestBrandWebsite(官网自动发现)', () => {
  function stubAgent(content: unknown, settings?: Partial<InsightAgentSettings>) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return new InsightAgent({
      settings: llmSettings(settings),
      fetchImpl: (async () =>
        content instanceof Error
          ? (() => {
              throw content;
            }) as unknown as Response
          : ({
              ok: true,
              status: 200,
              json: async () => ({ choices: [{ message: { content: text } }] }),
            }) as unknown as Response) as typeof fetch,
    });
  }

  it('LLM 给出候选:返回 url 与 confidence', async () => {
    const r = await stubAgent({ url: 'https://www.lixiang.com', confidence: 0.9 }).suggestBrandWebsite({
      name: '理想汽车',
      industry: '新能源汽车',
    });
    expect(r).toEqual({ url: 'https://www.lixiang.com', confidence: 0.9 });
  });

  it('LLM 坦言不知道(url=null):返回 null url 而非编造', async () => {
    const r = await stubAgent({ url: null, confidence: 0 }).suggestBrandWebsite({ name: '不知名小品牌' });
    expect(r?.url).toBeNull();
  });

  it('LLM 未启用:返回 null(不调用)', async () => {
    const agent = new InsightAgent({
      settings: { ...llmSettings(), enabled: false },
      fetchImpl: (async () => {
        throw new Error('不应发起调用');
      }) as unknown as typeof fetch,
    });
    const r = await agent.suggestBrandWebsite({ name: '理想汽车' });
    expect(r).toBeNull();
  });

  it('LLM 失败:返回 null(由调用方降级)', async () => {
    const agent = new InsightAgent({
      settings: llmSettings(),
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    const r = await agent.suggestBrandWebsite({ name: '理想汽车' });
    expect(r).toBeNull();
  });
});
