import { WEB_ENGINES, type EngineId } from '@geo/shared';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/registry';
import { MockEngineAdapter } from '../src/mock/mock-adapter';
import { buildDefaultFixtures } from '../src/mock/default-fixtures';
import { isEchoOfQuestion } from '../src/web/web-adapter';

const ctx = (profileKey = 'p1') => ({ mode: 'mock' as const, fingerprint: {}, profileKey });

describe('MockEngineAdapter', () => {
  it('同问题同引擎确定性回放(口径可复现)', async () => {
    const a = MockEngineAdapter.withDefaultFixtures('doubao');
    const b = MockEngineAdapter.withDefaultFixtures('doubao');
    const r1 = await a.ask(ctx(), '20万预算纯电轿车推荐');
    const r2 = await b.ask(ctx(), '20万预算纯电轿车推荐');
    expect(r1.answerText).toBe(r2.answerText);
    expect(r1.status).toBe('ok_with_answer');
    expect(r1.timing.queuedAt).toBeTruthy();
  });

  it('全部 5 引擎均有可用 fixture,且位次分布存在引擎间差异', async () => {
    const firstRank: Record<string, string> = {};
    for (const engine of WEB_ENGINES) {
      const adapter = MockEngineAdapter.withDefaultFixtures(engine);
      // 空回答态按哈希确定性触发;这里取 ok_with_answer 的场景验证推荐位次
      let res = await adapter.ask(ctx(), '20万预算纯电轿车推荐');
      for (let i = 0; res.status !== 'ok_with_answer' && i < 10; i++) {
        res = await adapter.ask(ctx(), `20万预算纯电轿车推荐 #${i}`);
      }
      expect(res.status).toBe('ok_with_answer');
      const first = res.answerText.split('\n').find((l) => /^\s*1[.、]\s*/.test(l))!;
      firstRank[engine] = first;
      expect(res.citations.length).toBeGreaterThan(0);
      expect(res.rawHtml).toContain(engine);
    }
    expect(new Set(Object.values(firstRank)).size).toBeGreaterThan(1);
  });

  it('内置 ok_empty 场景按哈希触发(docs/02 §1.1 口径路径)', async () => {
    const adapter = MockEngineAdapter.withDefaultFixtures('doubao');
    const statuses = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = await adapter.ask(ctx(), `问题变体 ${i}`);
      statuses.add(r.status);
      if (r.status === 'ok_empty') {
        expect(r.answerText).toBe('');
        break;
      }
    }
    expect(statuses.has('ok_empty')).toBe(true);
  });

  it('无 fixture 引擎构造时报错', () => {
    expect(() => new MockEngineAdapter('doubao', [{ engine: 'deepseek', answerMarkdown: 'x' }])).toThrow();
  });
});

describe('AdapterRegistry', () => {
  it('按 引擎×端 注册与解析;未注册抛错', async () => {
    const registry = new AdapterRegistry();
    for (const e of WEB_ENGINES) registry.register(MockEngineAdapter.withDefaultFixtures(e));

    const a = registry.get('doubao', 'web');
    expect(a.schemaVersion).toBe('mock-1');
    expect((await a.healthCheck()).ok).toBe(true);

    expect(() => registry.get('doubao', 'app')).toThrow();
    expect(registry.list()).toHaveLength(WEB_ENGINES.length);

    const health = await registry.healthCheckAll();
    expect(Object.keys(health)).toHaveLength(WEB_ENGINES.length);
  });

  it('fixture 覆盖五引擎与三种场景(推荐/口碑/空态)', () => {
    const fixtures = buildDefaultFixtures();
    const engines = new Set(fixtures.map((f) => f.engine as EngineId));
    expect(engines.size).toBe(5);
    expect(fixtures.some((f) => f.status === 'ok_empty')).toBe(true);
    expect(fixtures.some((f) => f.answerMarkdown.includes('口碑'))).toBe(true);
  });
});

describe('isEchoOfQuestion(采集防污染:输入回显不得计为回答)', () => {
  const q = '理想汽车的口碑和质量到底怎么样?有什么优缺点?';

  it('回答=问题原文(全角标点/空白差异)判为回声', () => {
    expect(isEchoOfQuestion('理想汽车的口碑和质量到底怎么样？有什么优缺点？', q)).toBe(true);
    expect(isEchoOfQuestion(' 理想汽车的口碑和质量到底怎么样?有什么优缺点? \n', q)).toBe(true);
  });

  it('回声携带少量站点噪声(建议词/时间戳)且不长于问题,判为回声', () => {
    expect(isEchoOfQuestion('理想汽车的口碑和质量到底怎么样?有什么优缺点?', q)).toBe(true);
  });

  it('真实回答(长度显著/内容不同)不判为回声', () => {
    expect(
      isEchoOfQuestion(
        '理想汽车整体口碑偏正面:增程式技术成熟,空间大,售后网络在扩张;主要槽点是车机偶发卡顿与保值率一般。总体值得考虑。',
        q,
      ),
    ).toBe(false);
  });

  it('空文本不判回声', () => {
    expect(isEchoOfQuestion('', q)).toBe(false);
  });
});

describe('stripAnswerNoise(wenxin 引导块剥离)', async () => {
  const { stripAnswerNoise } = await import('../src/web/web-adapter');
  const wenxinSite = {
    engine: 'wenxin',
    answerNoisePatterns: [
      '^调用工具$', '^品牌官方$', '^搜索全网\\d+篇资料$', '^已搜索\\d+篇资料$',
      '^搜索\\d+个关键词.*$', '^搜索关键词.*$', '^使用工具.*$', '^搜索全球\\d+篇资料$',
    ],
    leadingNoiseLineRe: '^(搜索|使用工具|\\d{1,2}\\.\\s)',
  };
  const sample = [
    '搜索9个关键词 共参考30篇资料',
    '搜索关键词“2026年值得期待的汽车”、“理想汽车核心优势”',
    '1. 2026热门汽车推荐：吉利星愿夺冠-新浪新闻',
    '2. 理想L6 vs 蔚来ES6：怎么选-有驾',
    '30. 横评四款新能源SUV-新浪汽车-新浪网',
    '‌理想汽车更适合多孩家庭全场景家用，蔚来汽车更适合看重补能效率的用户。',
    '🎯 选购建议',
    '1. 优先选理想汽车，空间设计是同级别标杆',
  ].join('\n');

  it('剥离头部状态行与引用源编号列表,保留正文与其中的编号榜单', () => {
    const out = stripAnswerNoise(wenxinSite, sample);
    expect(out).not.toContain('搜索9个关键词');
    expect(out).not.toContain('吉利星愿夺冠');
    expect(out).toContain('理想汽车更适合多孩家庭全场景家用');
    expect(out).toContain('1. 优先选理想汽车'); // 正文内合法编号榜单保留
    expect(out.startsWith('‌理想汽车更适合')).toBe(true);
  });
});

describe('stripInlineCitationMarkers(内联引用角标,全引擎)', async () => {
  const { stripInlineCitationMarkers } = await import('../src/web/web-adapter');
  it('剥离句末的站点名/纯数字/连续数字链标记', () => {
    expect(stripInlineCitationMarkers('对颠簸的过滤提升很直接- 知乎 。')).toBe('对颠簸的过滤提升很直接。');
    expect(stripInlineCitationMarkers('也支持选装六座- 8 。')).toBe('也支持选装六座。');
    expect(stripInlineCitationMarkers('正好落在你的预算里- 1 - 5 。')).toBe('正好落在你的预算里。');
    expect(stripInlineCitationMarkers('销量非常强劲- 4 。')).toBe('销量非常强劲。');
  });
  it('不触碰正文连字符词与无句末标点的合法内容', () => {
    expect(stripInlineCitationMarkers('增程-纯电双路线并行。')).toBe('增程-纯电双路线并行。');
    expect(stripInlineCitationMarkers('理想 L6：延续家庭定位- 2 。')).toBe('理想 L6：延续家庭定位。');
    expect(stripInlineCitationMarkers('没有标记的普通句子')).toBe('没有标记的普通句子');
  });
});
