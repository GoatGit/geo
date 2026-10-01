import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TAIL_COMPLETION_MAX_AGE_DAYS } from '@geo/shared';

/** 问题×引擎 维度的最近一次有效 run(ok_with_answer/ok_empty)。 */
export interface LatestOkRun {
  questionId: number;
  engine: string;
  runId: number;
  ranAt: Date;
}

/** `${questionId}|${engine}`,矩阵/竞品/引用/口碑共用的对键。 */
export type RunPairKey = `${number}|${string}`;

export const runPairKey = (questionId: number, engine: string): RunPairKey => `${questionId}|${engine}`;

export interface TailRunIndex {
  /** 补齐龄期内每个 问题×引擎 的最近 ok run(含窗口内已覆盖的对) */
  byPair: Map<RunPairKey, LatestOkRun>;
  /** 仅窗口内无 ok run、需要回填的对(byPair 的子集,ranAt < windowSince) */
  tail: Map<RunPairKey, LatestOkRun>;
}

/** 尾部补齐查询所需的最小 db 结构(与 settings.ts 的 SettingsDb 同款约定,api/worker 皆可传) */
export type TailRunsDb = Pick<NodePgDatabase, 'execute'>;

/**
 * 明细尾部补齐索引(docs/02 §1):DISTINCT ON 取 TAIL_COMPLETION_MAX_AGE_DAYS 内每个
 * 问题×引擎 最近一次有效 run。窗口判定基于 run 而非 facts——ok run 必写 self fact
 * (extraction 对非 failed run 恒跑),故"窗口内有 ok run"⇔"窗口内有该对数据"。
 * 供 monitor.service(实时页)与 report-builder(报告)共用,单一口径。
 */
export async function latestOkRuns(
  db: TailRunsDb,
  brandId: number,
  windowSince: Date,
  maxAgeDays = TAIL_COMPLETION_MAX_AGE_DAYS,
): Promise<TailRunIndex> {
  const res = await db.execute(sql`
    select distinct on (question_id, engine)
      question_id, engine, id as run_id, ran_at
    from query_runs
    where brand_id = ${brandId}
      and status in ('ok_with_answer', 'ok_empty')
      and ran_at >= now() - (${maxAgeDays} * interval '1 day')
    order by question_id, engine, ran_at desc`);
  const rows =
    (res as unknown as { rows?: Array<{ question_id: string; engine: string; run_id: string; ran_at: Date }> }).rows ?? [];
  const byPair = new Map<RunPairKey, LatestOkRun>();
  const tail = new Map<RunPairKey, LatestOkRun>();
  for (const r of rows) {
    const entry: LatestOkRun = {
      questionId: Number(r.question_id),
      engine: r.engine,
      runId: Number(r.run_id),
      ranAt: new Date(r.ran_at),
    };
    byPair.set(runPairKey(entry.questionId, entry.engine), entry);
    if (entry.ranAt < windowSince) tail.set(runPairKey(entry.questionId, entry.engine), entry);
  }
  return { byPair, tail };
}
