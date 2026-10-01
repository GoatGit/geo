/**
 * 明细尾部补齐(docs/02 §1):窗口严格优先,窗口内完全缺席的 问题×引擎 对
 * 回填最近一次有效 run 的数据并标记 stale。纯函数,monitor.service(实时页)
 * 与 report-builder(报告)共用,保证两处同口径。
 */

/** 参与"窗口最好位次"折叠的单条事实输入(mention_facts 的最小投影)。 */
export interface PairFact {
  engine: string;
  mentioned: boolean;
  rank: number | null;
  runId: number;
  ranAt: Date;
}

/** 折叠产物:某 问题×引擎 的代表单元格(含数据时间与陈旧标记)。 */
export interface PairCell {
  engine: string;
  mentioned: boolean;
  rank: number | null;
  runId: number;
  /** 该单元格数据对应的采集时间(窗口内=窗口事实时间;回填=最近一次有效 run 时间) */
  ranAt: Date;
  /** true=窗口内无数据,来自最近一次有效 run 的回填(展示层标"N 天前") */
  stale: boolean;
}

/**
 * 位次更优判定(与排名透视历史口径一致):先"提及优于未提及",再"名次更小",
 * 同名次取更新的一次(runId 更大)。纯函数便于单测。
 */
function beats(f: PairFact, prev: PairCell): boolean {
  return (
    (f.mentioned && !prev.mentioned) ||
    (f.mentioned && f.rank !== null && (prev.rank === null || f.rank < prev.rank)) ||
    (f.mentioned === prev.mentioned && ((f.rank ?? null) === (prev.rank ?? null) && f.runId > prev.runId))
  );
}

/**
 * 每 问题×引擎 取一个代表单元格:先折叠窗口事实(历史"最好位次"语义),
 * 再对窗口完全缺席的引擎回填 tail 事实(每对至多一条,来自其最近一次有效 run)。
 * 窗口严格优先——窗口内 mentioned=false 不会被回填的 mentioned=true 击败。
 */
export function bestCellPerEngine(windowFacts: PairFact[], tailFacts: PairFact[]): Map<string, PairCell> {
  const perEngine = new Map<string, PairCell>();
  for (const f of windowFacts) {
    const prev = perEngine.get(f.engine);
    if (!prev || beats(f, prev)) {
      perEngine.set(f.engine, { engine: f.engine, mentioned: f.mentioned, rank: f.rank, runId: f.runId, ranAt: f.ranAt, stale: false });
    }
  }
  for (const f of tailFacts) {
    if (perEngine.has(f.engine)) continue; // 窗口已有该引擎数据,不回填
    perEngine.set(f.engine, { engine: f.engine, mentioned: f.mentioned, rank: f.rank, runId: f.runId, ranAt: f.ranAt, stale: true });
  }
  return perEngine;
}

/** 竞品/发现主体在尾部补齐中的单引擎样本计数(来自该主体×引擎最近一次出现的 run)。 */
export interface SubjectEngineAgg {
  runs: number;
  mentions: number;
  top3: number;
}

export interface TailSubjectFact {
  subjectKey: string;
  subjectName: string;
  engine: string;
  mentioned: boolean;
  rank: number | null;
  ranAt: Date;
}

export interface TailSubjectOverlay {
  /** 窗口缺席的主体×引擎对补入的样本(run 计数按 1 次计) */
  added: Array<{ subjectKey: string; subjectName: string; engine: string; agg: SubjectEngineAgg }>;
  /** subjectKey → 该主体回填数据的最近出现时间(展示层"N 天前") */
  lastSeenAt: Map<string, Date>;
}

/**
 * 竞品主体尾部补齐:窗口聚合里已出现的 主体×引擎 对不动;缺席对用回填 run 里的
 * 事实补一条样本(该对最近一次出现)。主体行据此获得 lastSeen 展示。
 */
export function overlayTailSubjects(windowPairs: Set<string>, tailFacts: TailSubjectFact[]): TailSubjectOverlay {
  const added: TailSubjectOverlay['added'] = [];
  const lastSeenAt = new Map<string, Date>();
  // 每对只取最近一条(tailFacts 理论上每对至多一条,防御性去重)
  const best = new Map<string, TailSubjectFact>();
  for (const f of tailFacts) {
    const k = `${f.subjectKey}|${f.engine}`;
    const prev = best.get(k);
    if (!prev || f.ranAt > prev.ranAt) best.set(k, f);
  }
  for (const [k, f] of best) {
    if (windowPairs.has(k)) continue;
    added.push({
      subjectKey: f.subjectKey,
      subjectName: f.subjectName,
      engine: f.engine,
      agg: { runs: 1, mentions: f.mentioned ? 1 : 0, top3: f.mentioned && f.rank !== null && f.rank <= 3 ? 1 : 0 },
    });
    const seen = lastSeenAt.get(f.subjectKey);
    if (!seen || f.ranAt > seen) lastSeenAt.set(f.subjectKey, f.ranAt);
  }
  return { added, lastSeenAt };
}
