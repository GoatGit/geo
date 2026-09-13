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
import { citationFacts, mentionFacts, monitoringQuestions, type Db } from '@geo/db';
import { sql } from 'drizzle-orm';
export type { SubjectDef } from '@geo/metrics';

export interface SubjectRow {
  id: number;
  kind: string;
  name: string;
  aliases: string[];
}

/** 轮次固化的识别口径 → 匹配主体(docs/05 §2 品牌匹配)。 */
export function toSubjects(rows: SubjectRow[], selfName: string): SubjectDef[] {
  return rows.map((r) => ({
    key: r.kind === 'self' ? 'self' : `${r.kind}:${r.id}`,
    kind: r.kind as SubjectDef['kind'],
    name: r.name,
    aliases: r.aliases ?? [],
  })).concat(
    // 保证本品一定参与(即使识别口径未确认,品牌名必匹配)
    rows.some((r) => r.kind === 'self') ? [] : [{ key: 'self', kind: 'self', name: selfName, aliases: [] }],
  );
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
}): Promise<{ facts: MentionFactDraft[]; rankedComposite: number | null }> {
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

  // 综合名次(02 §1.3):本问题本轮 self 的跨引擎中位数——按"当前轮内已落库事实"现算
  const self = facts.find((f) => f.subjectKind === 'self');
  const composite = self ? selfComposite(db, brandId, questionId, ranAt) : Promise.resolve(null);
  return { facts, rankedComposite: await composite };
}

async function selfComposite(
  db: Db,
  brandId: number,
  questionId: number,
  ranAt: Date,
): Promise<number | null> {
  const { eq, and, gte, lte } = await import('drizzle-orm');
  // 轮内 = ranAt 前后 30 分钟内的同问题事实(轮次 ID 不在事实表,用时间窗近似;轮次边界在调度侧保证)
  const rows = await db
    .select({ mentioned: mentionFacts.mentioned, rank: mentionFacts.rank })
    .from(mentionFacts)
    .where(
      and(
        eq(mentionFacts.brandId, brandId),
        eq(mentionFacts.questionId, questionId),
        eq(mentionFacts.subjectKind, 'self'),
        gte(mentionFacts.ranAt, new Date(ranAt.getTime() - 30 * 60_000)),
        lte(mentionFacts.ranAt, new Date(ranAt.getTime() + 30 * 60_000)),
      ),
    );
  if (rows.length === 0) return null;
  const n = rows.length;
  const normalized = rows.map((r) => (r.mentioned && r.rank !== null ? r.rank : n + 1));
  normalized.sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? normalized[mid]! : Math.ceil((normalized[mid - 1]! + normalized[mid]!) / 2);
}

/** 竞品自动发现(docs/05 §3.3):未匹配高频实体 → 待确认池(排除本品口径,A1 对策)。 */
export async function discoverCompetitors(input: {
  db: Db;
  brandId: number;
  answerText: string;
  subjects: SubjectDef[];
}): Promise<void> {
  const items = extractListItems(input.answerText);
  const competitorCandidatesTable = (await import('@geo/db')).competitorCandidates;
  for (const item of items) {
    const matched = input.subjects.some((s) => matchSubject(item.name, [s]) !== null);
    if (matched) continue;
    const name = item.name.trim().slice(0, 40);
    // 噪声过滤:实体不会是长句/含标点的描述行(生产由 LLM 实体抽取兜底,docs/05 §3.3)
    if (name.length < 2 || name.length > 16 || /[。:：;;,，]/.test(name)) continue;
    await input.db
      .insert(competitorCandidatesTable)
      .values({ brandId: input.brandId, name, occurrences: 1, contextSummary: item.raw.slice(0, 200) })
      .onConflictDoUpdate({
        target: [competitorCandidatesTable.brandId, competitorCandidatesTable.name],
        set: { occurrences: sql`${competitorCandidatesTable.occurrences} + 1` },
      });
  }
  void monitoringQuestions;
}
