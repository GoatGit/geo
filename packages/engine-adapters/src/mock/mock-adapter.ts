import { createHash } from 'node:crypto';
import type { EngineId } from '@geo/shared';
import type { AdapterHealth, AskOptions, AskResult, EngineAdapter, SessionContext } from '../types';
import { buildDefaultFixtures } from './default-fixtures';

export interface MockFixture {
  engine: EngineId;
  status?: 'ok_with_answer' | 'ok_empty';
  answerMarkdown: string;
  citations?: Array<{ url: string; title?: string }>;
  rawHtml?: string;
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock 适配器(docs/03 §4 多环境:dev 用 Mock 引擎适配器,回放录制的回答):
 * - 按 engine + 问题文本哈希确定性选择 fixture,同一问题永远同一回答(口径可复现)
 * - 模拟排队/首字/完成时间戳;可选延迟模拟引擎耗时
 */
export class MockEngineAdapter implements EngineAdapter {
  engine: EngineId;
  surface = 'web' as const;
  schemaVersion = 'mock-1';
  strategy = 'mock-replay' as const;

  private readonly fixtures: MockFixture[];

  constructor(
    engine: EngineId,
    fixtures: MockFixture[],
    private readonly opts: { latencyMs?: number } = {},
  ) {
    this.engine = engine;
    this.fixtures = fixtures.filter((f) => f.engine === engine);
    if (this.fixtures.length === 0) {
      throw new Error(`mock adapter ${engine}: no fixtures`);
    }
  }

  /** dev 默认:内置全引擎 fixtures(不同引擎位次有差异,E2E 矩阵可展示分化)。 */
  static withDefaultFixtures(engine: EngineId, opts?: { latencyMs?: number }): MockEngineAdapter {
    return new MockEngineAdapter(engine, buildDefaultFixtures(), opts);
  }

  async ask(ctx: SessionContext, question: string, opts?: AskOptions): Promise<AskResult> {
    const queuedAt = now();
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
    if (opts?.signal?.aborted) {
      return this.fail('aborted before replay', queuedAt);
    }

    const fixture = this.pickFixture(question);
    const firstTokenAt = now();
    const completedAt = now();

    return {
      status: fixture.status ?? 'ok_with_answer',
      answerText: fixture.answerMarkdown,
      rawHtml: fixture.rawHtml ?? `<html><body data-engine="${this.engine}">${fixture.answerMarkdown}</body></html>`,
      citations: fixture.citations ?? [],
      timing: { queuedAt, firstTokenAt, completedAt },
      engineMeta: { mode: 'mock-replay', fixtureStatus: fixture.status ?? 'ok_with_answer', profileKey: ctx.profileKey },
    };
  }

  async healthCheck(): Promise<AdapterHealth> {
    return { ok: true, detail: `mock:${this.fixtures.length} fixtures` };
  }

  private pickFixture(question: string): MockFixture {
    const answered = this.fixtures.filter((f) => (f.status ?? 'ok_with_answer') === 'ok_with_answer');
    // 哈希选择:确定性问题 → 确定性回答;每第 5 个问题(哈希尾数)用 empty 态,
    // 驱动 ok_empty 口径路径的测试(docs/02 §1.1)
    const hash = createHash('sha256').update(`${this.engine}:${question}`).digest();
    if (hash[0]! % 5 === 0) {
      const empty = this.fixtures.find((f) => f.status === 'ok_empty');
      if (empty) return empty;
    }
    return answered[hash[1]! % answered.length] ?? this.fixtures[0]!;
  }

  private fail(detail: string, queuedAt: string): AskResult {
    return {
      status: 'failed',
      answerText: '',
      rawHtml: null,
      citations: [],
      timing: { queuedAt, firstTokenAt: queuedAt, completedAt: now() },
      engineMeta: { error: detail },
    };
  }
}
