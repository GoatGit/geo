import { describe, expect, it } from 'vitest';
import { bestCellPerEngine, overlayTailSubjects, type PairFact, type TailSubjectFact } from '../src/tail-overlay';

const d = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const f = (over: Partial<PairFact> & { engine: string }): PairFact => ({
  mentioned: false,
  rank: null,
  runId: 1,
  ranAt: d(0),
  ...over,
});

describe('bestCellPerEngine(窗口最好位次 + 尾部补齐)', () => {
  it('窗口内:提及优于未提及,名次更小者优先,同名次取更新一次', () => {
    const cells = bestCellPerEngine(
      [
        f({ engine: 'doubao', mentioned: false, rank: null, runId: 10 }),
        f({ engine: 'doubao', mentioned: true, rank: 4, runId: 11 }),
        f({ engine: 'doubao', mentioned: true, rank: 2, runId: 12 }),
        f({ engine: 'qwen', mentioned: true, rank: 3, runId: 20 }),
        f({ engine: 'qwen', mentioned: true, rank: 3, runId: 21 }),
      ],
      [],
    );
    expect(cells.get('doubao')).toMatchObject({ mentioned: true, rank: 2, runId: 12, stale: false });
    expect(cells.get('qwen')).toMatchObject({ rank: 3, runId: 21, stale: false });
  });

  it('窗口严格优先:窗口内 mentioned=false 不被回填的 mentioned=true 击败', () => {
    const cells = bestCellPerEngine(
      [f({ engine: 'doubao', mentioned: false, runId: 5 })],
      [f({ engine: 'doubao', mentioned: true, rank: 1, runId: 99, ranAt: d(3) })],
    );
    expect(cells.get('doubao')).toMatchObject({ mentioned: false, stale: false, runId: 5 });
  });

  it('窗口完全缺席的引擎回填最近一次有效结果,标 stale 与 asOf', () => {
    const cells = bestCellPerEngine(
      [f({ engine: 'doubao', mentioned: true, rank: 1, runId: 5 })],
      [
        f({ engine: 'qwen', mentioned: true, rank: 2, runId: 3, ranAt: d(4) }),
        f({ engine: 'wenxin', mentioned: false, runId: 4, ranAt: d(9) }),
      ],
    );
    const qwen = cells.get('qwen')!;
    expect(qwen).toMatchObject({ mentioned: true, rank: 2, stale: true });
    expect(qwen.ranAt.getTime()).toBe(d(4).getTime());
    expect(cells.get('wenxin')).toMatchObject({ mentioned: false, stale: true });
    expect(cells.get('doubao')!.stale).toBe(false);
  });

  it('空窗口 + 有回填:全部引擎来自回填(调用方三率/名次据此计入)', () => {
    const cells = bestCellPerEngine([], [f({ engine: 'doubao', mentioned: true, rank: 1, runId: 2, ranAt: d(2) })]);
    expect(cells.size).toBe(1);
    expect(cells.get('doubao')).toMatchObject({ mentioned: true, rank: 1, stale: true });
  });
});

describe('overlayTailSubjects(竞品主体尾部补齐)', () => {
  const tf = (over: Partial<TailSubjectFact> & { subjectKey: string }): TailSubjectFact => ({
    subjectName: over.subjectKey,
    engine: 'doubao',
    mentioned: true,
    rank: null,
    ranAt: d(1),
    ...over,
  });

  it('窗口已出现的 主体×引擎 对不回填;缺席对补 1 次样本并记 lastSeen', () => {
    // 时间值各算一次复用:d(n) 每次调用取 Date.now(),断言处再算会差毫秒导致 flake
    const nijieAt = d(1);
    const aitoAt = d(6);
    const { added, lastSeenAt } = overlayTailSubjects(
      new Set(['wenjie|doubao', 'nijie|qwen']),
      [
        tf({ subjectKey: 'wenjie', engine: 'doubao', mentioned: true, rank: 1 }), // 窗口已有,跳过
        tf({ subjectKey: 'nijie', engine: 'doubao', mentioned: true, rank: 1, ranAt: nijieAt }), // 引擎缺席,补
        tf({ subjectKey: 'aito', engine: 'yuanbao', mentioned: false, rank: null, ranAt: aitoAt }),
      ],
    );
    expect(added).toHaveLength(2);
    expect(added.find((a) => a.subjectKey === 'nijie' && a.engine === 'doubao')!.agg).toEqual({ runs: 1, mentions: 1, top3: 1 });
    expect(added.find((a) => a.subjectKey === 'aito')!.agg).toEqual({ runs: 1, mentions: 0, top3: 0 });
    expect(lastSeenAt.get('nijie')!.getTime()).toBe(nijieAt.getTime());
    expect(lastSeenAt.get('aito')!.getTime()).toBe(aitoAt.getTime());
    expect(lastSeenAt.has('wenjie')).toBe(false);
  });

  it('同对多条回填事实只取最近一条', () => {
    const { added } = overlayTailSubjects(
      new Set(),
      [
        tf({ subjectKey: 'nijie', mentioned: true, rank: 3, ranAt: d(5) }),
        tf({ subjectKey: 'nijie', mentioned: false, ranAt: d(2) }), // 更新的一次
      ],
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.agg).toEqual({ runs: 1, mentions: 0, top3: 0 });
  });
});
