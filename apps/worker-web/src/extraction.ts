import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { PARSER_VERSION, type MentionFactDraft } from '@geo/shared';
import {
  buildMentionFacts,
  classifyDomain,
  extractListItems,
  isOwnedDomain,
  matchSubject,
  normalizeUrl,
  type SubjectDef,
} from '@geo/metrics';
import { citationFacts, competitorCandidates, loadPlatformSettings, mentionFacts, type Db } from '@geo/db';
import { toMentionDrafts } from '@geo/insight-agent';
import { createInsightAgent, incrInsightStat } from './insight';
export type { SubjectDef } from '@geo/metrics';

export interface SubjectRow {
  id: number;
  kind: string;
  name: string;
  aliases: string[];
}

/** 轮次固化的识别口径 → 匹配主体(docs/05 §2 品牌匹配)。 */
export function toSubjects(rows: SubjectRow[], selfName: string): SubjectDef[] {
  return rows
    .map((r) => ({
      key: r.kind === 'self' ? 'self' : `${r.kind}:${r.id}`,
      kind: r.kind as SubjectDef['kind'],
      name: r.name,
      aliases: r.aliases ?? [],
    }))
    .concat(
      // 保证本品一定参与(即使识别口径未确认,品牌名必匹配)
      rows.some((r) => r.kind === 'self') ? [] : [{ key: 'self', kind: 'self', name: selfName, aliases: [] }],
    );
}

/** 竞品候选噪声过滤(docs/05 §3.3):实体不是长句/含标点的描述行(生产由 LLM 实体抽取兜底)。 */
export function isPlausibleEntityName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 16 && !/[。:：;;,，]/.test(trimmed);
}

/** 即时抽取(docs/05 §2):mention_facts + citation_facts。
 *  判定层 = Insight Agent(docs/09 §6):mode=llm 时 LLM 判定、失败回落规则(置信度压 0.5 进抽检池);
 *  mode=shadow 时口径仍走规则、LLM 判定入 query_runs.meta.insightShadow 对比。 */
export async function runInstantExtraction(input: {
  db: Db;
  runId: number;
  brandId: number;
  questionId: number;
  engine: string;
  ranAt: Date;
  answerText: string;
  questionText?: string;
  citations: Array<{ url: string; title?: string }>;
  subjects: SubjectDef[];
  ownedDomains: string[];
  redis?: Redis | null;
}): Promise<{ facts: MentionFactDraft[] }> {
  const { db, runId, brandId, questionId, engine, ranAt, answerText, citations, subjects, ownedDomains } = input;

  const draftBase = { runId: String(runId), brandId };
  let facts = buildMentionFacts({ runId: String(runId), brandId, subjects, markdown: answerText });

  // Insight Agent 判定层:仅 ok 回答文本非空时才值得调用;配置经 platform_settings 每 run 读取(切模式即时生效)
  const insightCfg = (await loadPlatformSettings(db)).insightAgent;
  if (answerText.trim() && insightCfg.enabled && (insightCfg.mode === 'llm' || insightCfg.mode === 'shadow')) {
    const agent = createInsightAgent(insightCfg, input.redis ?? null);
    const judged = await agent.judgeMention({
      question: input.questionText ?? '',
      answerMarkdown: answerText,
      subjects,
    });
    if (judged) {
      const llmFacts = toMentionDrafts(judged, draftBase);
      if (insightCfg.mode === 'llm') {
        facts = llmFacts;
      } else {
        // 影子:口径保持规则结果,双侧判定差异入 meta 供离线评测(docs/09 §7)
        const agree =
          facts.length === llmFacts.length &&
          facts.every((rf) => {
            const lf = llmFacts.find((l) => l.subjectKey === rf.subjectKey);
            return lf && rf.mentioned === lf.mentioned && rf.rank === lf.rank;
          });
        if (!agree) void incrInsightStat(input.redis ?? null, 'shadow_disagree');
        await db
          .execute(sql`
            update query_runs
            set meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({
              insightShadow: {
                task: 'mention',
                agree,
                rule: facts.map((f) => ({ key: f.subjectKey, mentioned: f.mentioned, rank: f.rank })),
                llm: llmFacts.map((f) => ({ key: f.subjectKey, mentioned: f.mentioned, rank: f.rank })),
                parserVersion: judged.parserVersion,
              },
            })}::jsonb
            where id = ${runId}
          `)
          .catch((err) => console.error(`[insight] shadow write failed run=${runId}:`, err));
      }
    } else if (insightCfg.mode === 'llm') {
      // 降级矩阵(docs/09 §6):规则结果照常入库,置信度压 0.5 → 进人工抽检池
      facts = facts.map((f) => ({ ...f, confidence: Math.min(f.confidence, 0.5) }));
    }
  }

  for (const f of facts) {
    await db.insert(mentionFacts).values({
      runId,
      brandId,
      subjectKind: f.subjectKind,
      subjectKey: f.subjectKey,
      subjectName: f.subjectName,
      mentioned: f.mentioned,
      rank: f.rank,
      coRanked: f.coRanked,
      ranAt,
      engine,
      surface: 'web',
      questionId,
      evidence: f.evidence as unknown as Record<string, unknown> | null,
      parserVersion: f.parserVersion,
      confidence: f.confidence,
    });
  }

  // 引用即时抽取(教训 A6 对策:引用卡同步通路,只把"正文散落链接"留给异步管道)
  for (const c of citations) {
    const { url, domain } = normalizeUrl(c.url);
    const cls = classifyDomain(domain);
    await db.insert(citationFacts).values({
      runId,
      brandId,
      rawUrl: url,
      domain,
      platformCategory: cls.category,
      title: c.title ?? null,
      isOwned: isOwnedDomain(domain, ownedDomains),
      engine,
      questionId,
      extractedAt: ranAt,
      parserVersion: PARSER_VERSION,
    });
  }

  return { facts };
}

/** 竞品自动发现(docs/05 §3.3):未匹配高频实体 → 待确认池(排除本品口径,A1 对策)。 */
export async function discoverCompetitors(input: {
  db: Db;
  brandId: number;
  answerText: string;
  subjects: SubjectDef[];
}): Promise<void> {
  const items = extractListItems(input.answerText);
  for (const item of items) {
    const matched = input.subjects.some((s) => matchSubject(item.name, [s]) !== null);
    if (matched) continue;
    const name = item.name.trim().slice(0, 40);
    if (!isPlausibleEntityName(name)) continue;
    await input.db
      .insert(competitorCandidates)
      .values({ brandId: input.brandId, name, occurrences: 1, contextSummary: item.raw.slice(0, 200) })
      .onConflictDoUpdate({
        target: [competitorCandidates.brandId, competitorCandidates.name],
        set: { occurrences: sql`${competitorCandidates.occurrences} + 1` },
      });
  }
}
