/**
 * 存量排名回填(2026-09-21 首位评述口径,commit b719d02):
 * 对 mentioned=true 且 rank=null 的历史 run,按新判定语义重新判位次
 * (问题点名某主体且回答主体围绕它展开 → rank=1)。
 *
 * 用法:
 *   tsx scripts/backfill-first-review.mts            # dry-run,只报告
 *   APPLY=1 tsx scripts/backfill-first-review.mts    # 实际回写
 *   LIMIT=20 tsx ...                                 # 限量试跑
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createStorageFromEnv, type EvidenceStorage } from '@geo/evidence';
import { InsightAgent } from '@geo/insight-agent';

// ── env 引导(ENV_FILE 指定环境文件,默认 repo 根 .env)──
const envFile = process.env.ENV_FILE ?? '/Users/yanghuaiyuan/AI/geo/.env';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const APPLY = process.env.APPLY === '1';
const LIMIT = Number(process.env.LIMIT ?? 0);

// ── 平台设置(InsightAgent 配置在库里)──
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const settingsRow = (await q(`select value from platform_settings where key = 'insightAgent' limit 1`))[0];
if (!settingsRow) throw new Error('platform_settings.insight_agent 缺失');
const insightCfg = typeof settingsRow.value === 'string' ? JSON.parse(settingsRow.value) : settingsRow.value;
if (!insightCfg.enabled) throw new Error('Insight Agent 未启用');

const agent = new InsightAgent({ settings: insightCfg });
const storage: EvidenceStorage = createStorageFromEnv(process.env);

// ── 受影响 run(mentioned=true 且 rank=null),附问题拓写文本 ──
const runs = await q(
  `select distinct qr.id, qr.brand_id, qr.answer_ref, q.text_expanded as question
   from mention_facts mf
   join query_runs qr on qr.id = mf.run_id
   join monitoring_questions q on q.id = mf.question_id
   where mf.mentioned = true and mf.rank is null
   order by qr.id
   ${LIMIT > 0 ? `limit ${LIMIT}` : ''}`,
);

console.log(`受影响 runs: ${runs.length}${APPLY ? '(APPLY)' : '(dry-run)'}`);
let scanned = 0;
let changedRuns = 0;
let changedFacts = 0;
let failed = 0;

for (const run of runs) {
  scanned += 1;
  try {
    // 判定时的主体集合 = 该 run 的 mention_facts(key/kind/name 原样还原)
    const facts = await q(
      `select id, subject_key, subject_kind, subject_name, rank from mention_facts where run_id = $1`,
      [run.id],
    );
    const subjects = facts.map((f) => ({
      key: f.subject_key,
      kind: f.subject_kind,
      name: f.subject_name,
      aliases: [] as string[],
    }));
    // 答案原文
    const raw = await (storage as unknown as { get(p: string): Promise<Buffer> }).get(run.answer_ref);
    const answerJson = JSON.parse(raw.toString('utf8')) as { answerText?: string };
    const answerText = answerJson.answerText ?? '';
    if (!answerText.trim()) continue;

    const judged = await agent.judgeMention({ question: run.question, answerMarkdown: answerText, subjects });
    if (!judged) {
      failed += 1;
      continue;
    }
    const updates: Array<{ id: number; name: string; rank: number }> = [];
    for (const j of judged.judges) {
      if (j.rank == null) continue;
      const fact = facts.find((f) => f.subject_key === j.key);
      // 只补 null → 有值;不改动已有位次,也不把 null 判得更差
      if (fact && fact.rank == null && j.mentioned) updates.push({ id: fact.id, name: j.name, rank: j.rank });
    }
    if (updates.length === 0) continue;
    changedRuns += 1;
    changedFacts += updates.length;
    console.log(
      `run #${run.id} [${run.question.slice(0, 24)}…] → ${updates.map((u) => `${u.name}=第${u.rank}`).join(', ')}`,
    );
    if (APPLY) {
      for (const u of updates) {
        await pool.query(`update mention_facts set rank = $1, confidence = 0.9 where id = $2`, [u.rank, u.id]);
      }
    }
  } catch (err) {
    failed += 1;
    console.error(`run #${run.id} 失败: ${(err as Error).message.slice(0, 140)}`);
  }
}

console.log(`完成:扫描 ${scanned},变化 ${changedRuns} runs / ${changedFacts} facts,失败 ${failed}${APPLY ? '' : '(dry-run 未写库)'}`);
await pool.end();
