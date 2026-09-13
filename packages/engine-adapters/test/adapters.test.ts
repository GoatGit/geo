import { WEB_ENGINES, type EngineId } from '@geo/shared';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/registry';
import { MockEngineAdapter } from '../src/mock/mock-adapter';
import { buildDefaultFixtures } from '../src/mock/default-fixtures';

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
