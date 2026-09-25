import { validateSurveyQuestions, validateSurveySegments } from '@geo/shared';
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

export interface WebsiteOutput {
  url: string | null;
  confidence: number;
}

/** 官网发现输出校验:URL 形态合法才接受;null(不知道)合法。 */
export function validateWebsiteOutput(v: unknown): ValidateResult<WebsiteOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  if (v.url == null || v.url === '') return { ok: true, value: { url: null, confidence: 0 } };
  const url = String(v.url).trim();
  if (!/^https?:\/\/./i.test(url)) return { ok: false, errors: [`url not http(s): ${url.slice(0, 60)}`] };
  const raw = String(v.confidence ?? 0.5);
  const n = Number(raw);
  const confidence = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0.5;
  return { ok: true, value: { url, confidence } };
}

export interface LayerOutput {
  items: Array<{ q: string; layer: string }>;
}

/** 分层补齐输出校验:层名必须在白名单、问题必须在输入列表(逐字匹配);越权条目直接丢弃。 */
export function validateLayerOutput(
  v: unknown,
  ctx: { questions: string[]; layers: readonly string[] },
): ValidateResult<LayerOutput> {
  if (!isRecord(v) || !Array.isArray(v.items)) return { ok: false, errors: ['items not an array'] };
  const qs = new Set(ctx.questions);
  const layers = new Set(ctx.layers);
  const items: LayerOutput['items'] = [];
  for (const item of (v.items as unknown[])) {
    if (!isRecord(item)) continue;
    const q = typeof item.q === 'string' ? item.q.trim() : '';
    const layer = typeof item.layer === 'string' ? item.layer.trim() : '';
    if (!q || !layers.has(layer)) continue; // 层名越权 → 丢
    if (!qs.has(q)) continue; // 编造问题 → 丢
    if (items.some((x) => x.q === q)) continue; // 重复 → 丢
    items.push({ q, layer });
  }
  if (items.length === 0) return { ok: false, errors: ['no valid items'] };
  return { ok: true, value: { items } };
}

/** 超级问卷:生成的问卷题目与 AI 建议人群(docs/11 §4);选项越权/题目越界在生成入口即拒。 */
export interface SurveyGenOutput {
  questions: Array<{ id: string; type: 'single' | 'multi' | 'scale' | 'open'; text: string; options?: string[] }>;
  segments: Array<{
    ageBand: string;
    cityTier: string;
    incomeBand: string;
    gender: string;
    occupationGroup: string;
    count: number;
  }>;
}

export function validateSurveyGenOutput(v: unknown): ValidateResult<SurveyGenOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const questions = validateSurveyQuestions(v.questions);
  const segments = validateSurveySegments(v.segments);
  const errors = [...(!questions.ok ? questions.errors : []), ...(!segments.ok ? segments.errors : [])];
  if (!Array.isArray(v.questions) || v.questions.length < 5 || v.questions.length > 10) errors.push('questions count out of 5..10');
  if (errors.length || !questions.ok || !segments.ok) return { ok: false, errors };
  return { ok: true, value: { questions: questions.value, segments: segments.value } };
}

/** 超级问卷:单个 persona 的作答结果;逐题校验 answer 与题型匹配。 */
export interface PersonaAnswerOutput {
  answers: Array<{ questionId: string; answer: string | number | string[]; comment?: string }>;
}

export function validatePersonaAnswerOutput(
  v: unknown,
  ctx: { questions: Array<{ id: string; type: string; options?: string[] }> },
): ValidateResult<PersonaAnswerOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const defs = new Map(ctx.questions.map((q) => [q.id, q]));
  const errors: string[] = [];
  const answers: PersonaAnswerOutput['answers'] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(v.answers) ? v.answers : [];
  for (const [i, a] of raw.entries()) {
    if (!isRecord(a)) {
      errors.push(`answers[${i}] not an object`);
      continue;
    }
    const qid = typeof a.questionId === 'string' ? a.questionId : '';
    const def = defs.get(qid);
    if (!def || seen.has(qid)) { errors.push(`answers[${i}] unknown or duplicated question`); continue; }
    const answer = a.answer;
    if (def.type === 'scale') {
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 1 || answer > 10) {
        errors.push(`answers[${i}] ${qid} scale out of 1..10`);
        continue;
      }
    } else if (def.type === 'multi') {
      const opts = new Set(def.options ?? []);
      if (!Array.isArray(answer) || answer.length === 0 || new Set(answer).size !== answer.length || !answer.every((o) => typeof o === 'string' && opts.has(o))) {
        errors.push(`answers[${i}] ${qid} multi invalid`);
        continue;
      }
    } else if (def.type === 'single') {
      const opts = new Set(def.options ?? []);
      if (typeof answer !== 'string' || !opts.has(answer)) {
        errors.push(`answers[${i}] ${qid} single not in options`);
        continue;
      }
    } else {
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 1000) {
        errors.push(`answers[${i}] ${qid} open invalid`);
        continue;
      }
    }
    seen.add(qid);
    const comment = typeof a.comment === 'string' ? a.comment.trim().slice(0, 200) : '';
    answers.push(comment ? { questionId: qid, answer: answer as string | number | string[], comment } : { questionId: qid, answer: answer as string | number | string[] });
  }
  if (answers.length < ctx.questions.length) {
    errors.push(`answered ${answers.length}/${ctx.questions.length}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { answers } };
}

/** 人群库流水线(docs/12 §1):Persona Hub 描述的结构化结果;宽松验收,null 字段合法。 */
export interface PersonaEnrichOutput {
  occupation: string | null;
  occupationGroup: string | null;
  ageBand: string | null;
  cityTier: string | null;
  incomeBand: string | null;
  gender: string | null;
  traits: string[];
  confidence: number;
}

export function validatePersonaEnrichOutput(v: unknown): ValidateResult<PersonaEnrichOutput> {
  if (!isRecord(v)) return { ok: false, errors: ['root is not an object'] };
  const nullable = (k: string): string | null =>
    typeof v[k] === 'string' && (v[k] as string).trim() ? (v[k] as string).trim() : null;
  const confidence = typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : 0;
  return {
    ok: true,
    value: {
      occupation: nullable('occupation'),
      occupationGroup: nullable('occupationGroup'),
      ageBand: nullable('ageBand'),
      cityTier: nullable('cityTier'),
      incomeBand: nullable('incomeBand'),
      gender: nullable('gender'),
      traits: Array.isArray(v.traits) ? v.traits.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 8) : [],
      confidence,
    },
  };
}
