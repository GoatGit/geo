import { describe, expect, it } from 'vitest';
import { DEFAULT_INSIGHT_AGENT_SETTINGS, type InsightAgentSettings } from '@geo/shared';
import { InsightAgent, resolveInsightSettings, toMentionDrafts } from '../src';
import { validateMentionOutput, validateReputationOutput } from '../src/schema';

const llmSettings = (over: Partial<InsightAgentSettings> = {}): InsightAgentSettings => ({
  ...DEFAULT_INSIGHT_AGENT_SETTINGS,
  enabled: true,
  mode: 'llm',
  endpoint: 'https://llm.example.com/v1',
  apiKey: 'sk-test-123456',
  model: 'qwen-max',
  ...over,
});

function stubAgent(content: unknown | Error, events: unknown[] = [], settings?: Partial<InsightAgentSettings>) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const impl = (async () => {
    if (content instanceof Error) throw content;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: text } }] }),
    } as unknown as Response;
  }) as typeof fetch;
  const agent = new InsightAgent({
    settings: llmSettings(settings),
    fetchImpl: impl,
    onEvent: (e) => events.push(e),
  });
  return agent;
}

const SUBJECTS = [
  { key: 'self:su7', kind: 'self', name: '小米SU7', aliases: ['SU7'] },
  { key: 'comp:zhijie', kind: 'competitor', name: '智界S7', aliases: [] },
];

describe('InsightAgent.judgeMention', () => {
  it('未启用/缺配置时不调用,返回 null', async () => {
    const events: unknown[] = [];
    const agent = new InsightAgent({ settings: { ...DEFAULT_INSIGHT_AGENT_SETTINGS }, fetchImpl: (async () => {
      throw new Error('should not be called');
    }) as typeof fetch, onEvent: (e) => events.push(e) });
    expect(await agent.judgeMention({ question: 'q', answerMarkdown: 'a', subjects: SUBJECTS })).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('空回答短路:不发起调用,全主体未提及', async () => {
    const events: unknown[] = [];
    let called = 0;
    const impl = (async () => {
      called += 1;
      throw new Error('should not be called');
    }) as typeof fetch;
    const agent = new InsightAgent({ settings: llmSettings(), fetchImpl: impl, onEvent: (e) => events.push(e) });
    const r = await agent.judgeMention({ question: 'q', answerMarkdown: '  \n  ', subjects: SUBJECTS });
    expect(r?.answerEmpty).toBe(true);
    expect(r?.judges.every((j) => !j.mentioned && j.rank === null)).toBe(true);
    expect(called).toBe(0);
  });

  it('判定成功:栅栏 JSON 解析、幻觉 key 丢弃、缺失主体回填未提及', async () => {
    const events: unknown[] = [];
    const agent = stubAgent(
      '```json\n' +
        JSON.stringify({
          answerEmpty: false,
          subjects: [
            { key: 'self:su7', mentioned: true, rank: 1, confidence: 0.97, excerpt: '1. 小米SU7 是最值得推荐的' },
            { key: 'hallucinated:key', mentioned: true, rank: 2, confidence: 0.9, excerpt: 'x' },
          ],
        }) +
        '\n```',
      events,
    );
    const r = await agent.judgeMention({ question: '20万纯电轿车推荐', answerMarkdown: '1. 小米SU7 是最值得推荐的', subjects: SUBJECTS });
    expect(r).not.toBeNull();
    expect(r!.judges.find((j) => j.key === 'self:su7')).toMatchObject({ mentioned: true, rank: 1 });
    expect(r!.judges.find((j) => j.key === 'comp:zhijie')).toMatchObject({ mentioned: false, rank: null });
    expect(r!.judges.some((j) => j.key === 'hallucinated:key')).toBe(false);
    expect(r!.parserVersion).toMatch(/^insight@p1\+openai\/qwen-max$/);
    expect(events.some((e) => (e as { kind: string }).kind === 'invalid_partial')).toBe(true);
  });

  it('坏 JSON / 校验失败 → null + fallback 事件(调用方回落规则)', async () => {
    const events: unknown[] = [];
    const badJson = stubAgent('抱歉,我无法输出 JSON', events);
    expect(await badJson.judgeMention({ question: 'q', answerMarkdown: 'a', subjects: SUBJECTS })).toBeNull();
    expect(events.some((e) => (e as { kind: string }).kind === 'fallback')).toBe(true);

    const events2: unknown[] = [];
    const badShape = stubAgent({ answerEmpty: false, subjects: [{ key: 'self:su7', mentioned: true, rank: 999, confidence: 1, excerpt: 'x' }] }, events2);
    expect(await badShape.judgeMention({ question: 'q', answerMarkdown: 'a', subjects: SUBJECTS })).toBeNull();
    expect(events2.some((e) => (e as { kind: string }).kind === 'fallback')).toBe(true);
  });

  it('网络错误 → null(不抛出,降级由调用方处理)', async () => {
    const err = new Error('boom');
    err.name = 'TimeoutError';
    const agent = new InsightAgent({
      settings: llmSettings(),
      fetchImpl: (async () => {
        throw err;
      }) as typeof fetch,
    });
    expect(await agent.judgeMention({ question: 'q', answerMarkdown: 'a', subjects: SUBJECTS })).toBeNull();
  });
});

describe('toMentionDrafts(落库形态转换)', () => {
  it('evidence 摘录 + 同位次 coRanked + 未提及 evidence 置 null', () => {
    const judgement = {
      answerEmpty: false,
      parserVersion: 'insight@p1+openai/qwen-max',
      judges: [
        { ...SUBJECTS[0]!, mentioned: true, rank: 1, confidence: 0.97, excerpt: '1. 小米SU7 首推' },
        { ...SUBJECTS[1]!, mentioned: true, rank: 1, confidence: 0.9, excerpt: '并列第1还有智界S7' },
      ],
    };
    const drafts = toMentionDrafts(judgement, { runId: 'r1', brandId: 7 });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.coRanked)).toBe(true);
    expect(drafts[0]!.evidence).toMatchObject({ hitWord: '小米SU7', snippet: '1. 小米SU7 首推' });
    expect(drafts[0]!.parserVersion).toBe('insight@p1+openai/qwen-max');
  });
});

describe('reputation / classify / expand', () => {
  it('口碑:情绪 + 印象词直通校验', async () => {
    const agent = stubAgent({
      sentiment: 'neg',
      confidence: 0.92,
      impressions: [{ term: '不推荐', polarity: 'neg', excerpt: '这车我真心不推荐,小毛病多' }],
    });
    const r = await agent.judgeReputation({ brandName: '小米SU7', answerText: '这车我真心不推荐,小毛病多' });
    expect(r?.sentiment).toBe('neg');
    expect(r?.impressions[0]!.term).toBe('不推荐');
  });

  it('分类与拓写:正常返回;分类超时预算由调用方经 timeoutMs 传入', async () => {
    const agent = stubAgent({ type: 'reputation', confidence: 0.9 });
    expect((await agent.classify('这个车口碑怎么样'))?.type).toBe('reputation');

    const agent2 = stubAgent({ question: '预算20万买什么纯电轿车值得推荐?' });
    expect((await agent2.expand('20万纯电轿车推荐', '小米SU7', 2026))?.question).toContain('20万');
  });
});

describe('resolveInsightSettings(env 引导语义)', () => {
  it('库内从未保存(=默认值)时 env 生效', () => {
    const s = resolveInsightSettings({ ...DEFAULT_INSIGHT_AGENT_SETTINGS }, {
      INSIGHT_AGENT_ENABLED: 'true',
      INSIGHT_AGENT_MODE: 'shadow',
      INSIGHT_AGENT_ENDPOINT: 'https://env.example.com/v1',
      INSIGHT_AGENT_API_KEY: 'sk-env',
      INSIGHT_AGENT_MODEL: 'glm-x',
      INSIGHT_AGENT_PROTOCOL: 'anthropic',
    } as NodeJS.ProcessEnv);
    expect(s).toMatchObject({ enabled: true, mode: 'shadow', endpoint: 'https://env.example.com/v1', apiKey: 'sk-env', model: 'glm-x', protocol: 'anthropic' });
  });

  it('库内已有显式配置时 env 不覆盖(管理后台优先)', () => {
    const stored = llmSettings({ model: 'saved-model' });
    const s = resolveInsightSettings(stored, { INSIGHT_AGENT_MODEL: 'env-model', INSIGHT_AGENT_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(s.model).toBe('saved-model');
    expect(s.enabled).toBe(true);
  });
});

describe('schema 校验器', () => {
  it('mention:mentioned 缺摘录判非法;rank=null 放行', () => {
    const bad = validateMentionOutput({ answerEmpty: false, subjects: [{ key: 'a', mentioned: true, rank: null, confidence: 1, excerpt: '' }] });
    expect(bad.ok).toBe(false);
    const good = validateMentionOutput({ answerEmpty: false, subjects: [{ key: 'a', mentioned: true, rank: null, confidence: 0.8, excerpt: '提到过' }] });
    expect(good.ok).toBe(true);
  });

  it('reputation:sentiment 非法整包拒绝;部分印象词非法仅丢弃', () => {
    expect(validateReputationOutput({ sentiment: 'angry', confidence: 1, impressions: [] }).ok).toBe(false);
    const partial = validateReputationOutput({
      sentiment: 'pos',
      confidence: 1,
      impressions: [{ term: '省电', polarity: 'pos', excerpt: 'x' }, { term: '', polarity: 'pos', excerpt: 'y' }],
    });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.value.impressions).toHaveLength(1);
  });
});
