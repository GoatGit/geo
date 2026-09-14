import { sql } from 'drizzle-orm';
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
import { citationFacts, competitorCandidates, mentionFacts, type Db } from '@geo/db';
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

/** 即时抽取(docs/05 §2,<2s 同步路径):mention_facts + citation_facts。 */
export async function runInstantExtraction(input: {
  db: Db;
  runId: number;
  brandId: number;
  questionId: number;
  engine: string;
  ranAt: Date;
  answerText: string;
  citations: Array<{ url: string; title?: string }>;
  subjects: SubjectDef[];
  ownedDomains: string[];
}): Promise<{ facts: MentionFactDraft[] }> {
  const { db, runId, brandId, questionId, engine, ranAt, answerText, citations, subjects, ownedDomains } = input;

  const facts = buildMentionFacts({ runId: String(runId), brandId, subjects, markdown: answerText });
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
      parserVersion: PARSER_VERSION,
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
