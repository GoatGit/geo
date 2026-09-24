/** Shared survey contracts: API, worker and editor use identical limits. */
export const SURVEY_MAX_SAMPLE = 2000;
export const SURVEY_MAX_QUESTIONS = 20;
export const SURVEY_BUSY = ['generating', 'queued', 'running'] as const;
export interface SurveyQuestion { id: string; type: 'single' | 'multi' | 'scale' | 'open'; text: string; options?: string[] }
export interface SurveySegment { ageBand: string; cityTier: string; incomeBand: string; gender: string; occupationGroup: string; count: number }
export type SurveyAnswer = { questionId: string; answer: string | number | string[] };
export type SurveyValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export const SURVEY_DIMENSIONS = { gender: '性别', ageBand: '年龄', cityTier: '城市', incomeBand: '年收入', occupationGroup: '职业' } as const;
export type SurveyDimension = keyof typeof SURVEY_DIMENSIONS;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateSurveyQuestions(input: unknown): SurveyValidation<SurveyQuestion[]> {
  if (!Array.isArray(input) || !input.length || input.length > SURVEY_MAX_QUESTIONS) return { ok: false, errors: ['问卷需包含 1–20 道题'] };
  const errors: string[] = [], value: SurveyQuestion[] = [], ids = new Set<string>();
  input.forEach((raw, i) => {
    if (!record(raw)) { errors.push(`第 ${i + 1} 题格式不正确`); return; }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || ['constructor', 'prototype'].includes(id) || ids.has(id)) errors.push(`第 ${i + 1} 题标识无效或重复`);
    ids.add(id);
    if (!text || text.length > 200) errors.push(`第 ${i + 1} 题需填写 1–200 字题目`);
    if (!['single', 'multi', 'scale', 'open'].includes(String(raw.type))) { errors.push(`第 ${i + 1} 题题型无效`); return; }
    const type = raw.type as SurveyQuestion['type'];
    if (type === 'single' || type === 'multi') {
      const options = Array.isArray(raw.options) ? raw.options.map(o => typeof o === 'string' ? o.trim() : '') : [];
      if (options.length < 2 || options.length > 10 || options.some(o => !o || o.length > 100) || new Set(options).size !== options.length) errors.push(`第 ${i + 1} 题需有 2–10 个不重复的选项，每项 1–100 字`);
      value.push({ id, text, type, options });
    } else value.push({ id, text, type });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateSurveySegments(input: unknown): SurveyValidation<SurveySegment[]> {
  if (!Array.isArray(input) || !input.length || input.length > 20) return { ok: false, errors: ['请选择 1–20 组人群'] };
  const value: SurveySegment[] = [], errors: string[] = [];
  input.forEach((raw, i) => {
    if (!record(raw)) { errors.push(`第 ${i + 1} 组人群格式不正确`); return; }
    const seg = {} as SurveySegment;
    for (const key of Object.keys(SURVEY_DIMENSIONS) as SurveyDimension[]) {
      const str = typeof raw[key] === 'string' ? raw[key].trim() : '';
      if (!str || str.length > 80) errors.push(`第 ${i + 1} 组${SURVEY_DIMENSIONS[key]}需填写 1–80 字`);
      seg[key] = str;
    }
    if (typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) || raw.count < 1 || raw.count > SURVEY_MAX_SAMPLE) errors.push(`第 ${i + 1} 组样本量需为 1–2000 的整数`);
    seg.count = Number(raw.count); value.push(seg);
  });
  if (value.reduce((n, s) => n + s.count, 0) > SURVEY_MAX_SAMPLE) errors.push('总样本量不能超过 2000');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export interface SurveyResponseRow { weight: number; profile: Record<string, unknown>; answers: SurveyAnswer[] }
function summarize(question: SurveyQuestion, rows: SurveyResponseRow[]) {
  const answers = rows.map(r => ({ ...r, answer: r.answers.find(a => a.questionId === question.id)?.answer })).filter(r => r.answer !== undefined);
  const total = answers.reduce((n, r) => n + r.weight, 0);
  const values = question.type === 'scale' ? Array.from({ length: 10 }, (_, i) => String(i + 1)) : question.options ?? [];
  const distribution = values.map(value => {
    const selected = answers.filter(r => Array.isArray(r.answer) ? r.answer.includes(value) : String(r.answer) === value);
    const weightedCount = selected.reduce((n, r) => n + r.weight, 0);
    return { value, count: selected.length, weightedCount, share: total ? weightedCount / total : 0 };
  });
  return {
    sampleSize: answers.length, weightedTotal: total, distribution,
    mean: question.type === 'scale' && total ? answers.reduce((n, r) => n + Number(r.answer) * r.weight, 0) / total : null,
    responses: question.type === 'open' ? answers.map(r => String(r.answer)).slice(0, 200) : [],
  };
}

export function aggregateSurvey(questions: SurveyQuestion[], input: SurveyResponseRow[], dimension?: SurveyDimension) {
  const rows = input.filter(r => Number.isFinite(r.weight) && r.weight > 0);
  const groups = new Map<string, SurveyResponseRow[]>();
  if (dimension) for (const row of rows) {
    const label = String(row.profile[dimension] ?? '未提供');
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  const combinations = new Set(rows.map(r => JSON.stringify(questions.map(q => r.answers.find(a => a.questionId === q.id)?.answer))));
  return {
    sampleSize: rows.length,
    diversity: rows.length ? combinations.size / rows.length : 0,
    questions: questions.map(question => ({
      question, ...summarize(question, rows),
      groups: [...groups].map(([label, groupRows]) => ({ label, ...summarize(question, groupRows) })),
    })),
  };
}
export type SurveyReportStats = ReturnType<typeof aggregateSurvey>;
