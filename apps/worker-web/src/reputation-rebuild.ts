import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { monitoringQuestions, queryRuns, reputationFacts } from '@geo/db';
import { createStorageFromEnv } from '@geo/evidence';
import { stripAnswerNoise, siteConfigOf } from '@geo/engine-adapters';
import { extractReputation } from './reputation';
import type { Redis } from 'ioredis';

/**
 * 口碑事实重建(采集清洗升级后的历史数据修复):
 * 近 N 天口碑 run → 读存证 answer.json → stripAnswerNoise(站点噪声) → 删旧插新。
 * 存证包(answer.json)只读不改(docs/04 §4 WORM);重建的是派生事实 reputation_facts。
 */
export async function rebuildReputation(db: Db, days: number, redis: Redis | null): Promise<{ rebuilt: number }> {
  const storage = createStorageFromEnv();
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await db
    .select({
      id: queryRuns.id,
      brandId: queryRuns.brandId,
      engine: queryRuns.engine,
      answerRef: queryRuns.answerRef,
      ranAt: queryRuns.ranAt,
    })
    .from(queryRuns)
    .innerJoin(monitoringQuestions, eq(monitoringQuestions.id, queryRuns.questionId))
    .where(
      and(
        eq(queryRuns.status, 'ok_with_answer'),
        eq(monitoringQuestions.type, 'reputation'),
        gte(queryRuns.ranAt, since),
        sql`${queryRuns.answerRef} is not null`,
      ),
    )
    .orderBy(queryRuns.id)
    .limit(2000);

  let rebuilt = 0;
  for (const r of rows) {
    try {
      const raw = await storage.get(r.answerRef!);
      const answer = JSON.parse(raw.toString('utf8')) as { answerText?: string };
      const cleaned = stripAnswerNoise(siteConfigOf(r.engine as never), answer.answerText ?? '');
      if (!cleaned.trim()) continue;
      await db.delete(reputationFacts).where(eq(reputationFacts.runId, r.id));
      await extractReputation(
        db,
        {
          runId: r.id,
          brandId: r.brandId,
          answerText: cleaned,
          ranAt: r.ranAt.toISOString(),
        },
        redis,
      );
      rebuilt += 1;
    } catch (err) {
      console.error(`[reputation-rebuild] run=${r.id} skipped:`, (err as Error).message.slice(0, 100));
    }
  }
  console.log(`[reputation-rebuild] rebuilt ${rebuilt}/${rows.length} runs(近 ${days} 天)`);
  return { rebuilt };
}

