/**
 * LLM 输出校验(docs/09 §5):手写零依赖校验器(仓库惯例,不引 zod)。
 * 原则:宁缺毋滥——非法条目丢弃并报告,不让幻觉数据进口径。
 */

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ClassifyOutput {
  type: 'ranking' | 'reputation';
  confidence: number;
}

export interface ExpandOutput {
  question: string;
}

export interface MentionSubjectOutput {
  key: string;
  mentioned: boolean;
  rank: number | null;
  confidence: number;
  excerpt: string;
}

export interface MentionOutput {
  answerEmpty: boolean;
  subjects: MentionSubjectOutput[];
}

export interface ReputationOutput {
  sentiment: 'pos' | 'neu' | 'neg';
  confidence: number;
  impressions: Array<{ term: string; polarity: 'pos' | 'neg'; excerpt: string }>;
}

function clamp01(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateClassifyOutput(v: unknown): ValidateResult<ClassifyOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  if (v.type !== 'ranking' && v.type !== 'reputation') {
    return { ok: false, errors: [`type must be ranking|reputation, got ${String(v.type)}`] };
  }
  return { ok: true, value: { type: v.type, confidence: clamp01(v.confidence, 0.6) } };
}

export function validateExpandOutput(v: unknown): ValidateResult<ExpandOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const q = typeof v.question === 'string' ? v.question.trim() : '';
  if (!q || q.length > 120) return { ok: false, errors: [`question empty or too long(${q.length})`] };
  return { ok: true, value: { question: q } };
}

/** rank 仅 1..99 或 null(与 docs/02 §1.2 位次口径一致);mentioned=false 强制 rank=null。 */
export function validateMentionOutput(v: unknown): ValidateResult<MentionOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const errors: string[] = [];
  const subjects: MentionSubjectOutput[] = [];
  const rawList = Array.isArray(v.subjects) ? v.subjects : [];
  for (const [i, item] of rawList.entries()) {
    if (!isRecord(item)) {
      errors.push(`subjects[${i}] not an object`);
      continue;
    }
    if (typeof item.key !== 'string' || !item.key) {
      errors.push(`subjects[${i}].key invalid`);
      continue;
    }
    const mentioned = item.mentioned === true;
    let rank: number | null = null;
    if (mentioned && item.rank !== null && item.rank !== undefined) {
      const n = Number(item.rank);
      if (Number.isInteger(n) && n >= 1 && n <= 99) rank = n;
      else errors.push(`subjects[${i}].rank out of range: ${String(item.rank)}`);
    }
    const excerpt = typeof item.excerpt === 'string' ? item.excerpt.slice(0, 200) : '';
    if (mentioned && !excerpt) errors.push(`subjects[${i}] mentioned without excerpt`);
    subjects.push({
      key: item.key,
      mentioned,
      rank,
      confidence: clamp01(item.confidence, 0.6),
      excerpt,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { answerEmpty: v.answerEmpty === true, subjects } };
}

export function validateReputationOutput(v: unknown): ValidateResult<ReputationOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const errors: string[] = [];
  if (v.sentiment !== 'pos' && v.sentiment !== 'neu' && v.sentiment !== 'neg') {
    return { ok: false, errors: [`sentiment invalid: ${String(v.sentiment)}`] };
  }
  const impressions: ReputationOutput['impressions'] = [];
  const rawList = Array.isArray(v.impressions) ? v.impressions : [];
  for (const [i, item] of rawList.entries()) {
    if (!isRecord(item)) {
      errors.push(`impressions[${i}] not an object`);
      continue;
    }
    if (typeof item.term !== 'string' || !item.term.trim() || (item.polarity !== 'pos' && item.polarity !== 'neg')) {
      errors.push(`impressions[${i}] term/polarity invalid`);
      continue;
    }
    impressions.push({
      term: item.term.trim().slice(0, 40),
      polarity: item.polarity,
      excerpt: typeof item.excerpt === 'string' ? item.excerpt.slice(0, 200) : '',
    });
  }
  if (errors.length > 0 && impressions.length === 0) return { ok: false, errors };
  return {
    ok: true,
    value: { sentiment: v.sentiment, confidence: clamp01(v.confidence, 0.6), impressions },
  };
}
