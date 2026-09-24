import type { SurveyAnswer, SurveyQuestion, SurveyValidation } from './surveys';
export interface CalibrationTarget { questionId: string; shares: Record<string, number> }
export interface CalibrationInput {
  title: string; source: string; population: string; sampleSize: number; collectedAt: string;
  targets: CalibrationTarget[];
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function validateCalibrationInput(input: unknown, questions: SurveyQuestion[]): SurveyValidation<CalibrationInput> {
  if (!record(input)) return { ok: false, errors: ['真人基准格式不正确'] };
  const errors: string[] = [];
  const text = (key: string, label: string, max: number) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!value || value.length > max) errors.push(`${label}不能为空且不能超过 ${max} 字`);
    return value;
  };
  const title = text('title', '基准名称', 120), source = text('source', '真人数据来源', 500), population = text('population', '真人调查对象', 300), collectedAt = text('collectedAt', '调查/发布日', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectedAt) || Number.isNaN(Date.parse(collectedAt)) || new Date(collectedAt).toISOString().slice(0,10) !== collectedAt) errors.push('请填写真人调查日期 YYYY-MM-DD');
  if (!Number.isSafeInteger(input.sampleSize) || Number(input.sampleSize) < 1 || Number(input.sampleSize) > 100_000_000) errors.push('真人有效样本量需为正整数');
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 10) return { ok: false, errors: [...errors, '选择 1–10 道基准题'] };
  const targets: CalibrationTarget[] = [], seen = new Set<string>();
  for (const raw of input.targets) {
    if (!record(raw) || typeof raw.questionId !== 'string' || seen.has(raw.questionId)) { errors.push('基准题无效或重复'); continue; }
    seen.add(raw.questionId);
    const q = questions.find(q => q.id === raw.questionId);
    if (!q || !['single', 'scale'].includes(q.type) || !record(raw.shares)) { errors.push('基准必须对应问卷中的单选题或量表题'); continue; }
    const values = q.type === 'scale' ? Array.from({ length: 10 }, (_, n) => String(n + 1)) : q.options ?? [];
    const shares: Record<string, number> = Object.create(null);
    if (Object.keys(raw.shares).length !== values.length) errors.push(`${q.id} 必须提供全部选项（含 0）`);
    for (const value of values) {
      const share = raw.shares[value];
      if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) errors.push(`${q.id} / ${value} 占比需在 0–1 之间`);
      shares[value] = Number(share);
    }
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.005) errors.push(`${q.id} 选项占比合计须为 100%`);
    else for (const key of values) shares[key] /= sum;
    targets.push({ questionId: q.id, shares });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { title, source, population, sampleSize: Number(input.sampleSize), collectedAt, targets } };
}

/** CSV stays on the client. Only anonymous, aggregate marginals need to reach the server. */
export function parseHumanCsv(csv: string, questions: SurveyQuestion[]): Pick<CalibrationInput, 'sampleSize' | 'targets'> {
  if (csv.length > 5_000_000) throw Error('CSV 最大 5 MB');
  const table: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') { if (quoted && input[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell.trim()); cell = '';
      if (c !== ',') { if (row.some(Boolean)) table.push(row); row = []; if (c === '\r' && input[i + 1] === '\n') i++; }
    } else cell += c;
  }
  if (quoted) throw Error('CSV 引号未闭合');
  row.push(cell.trim()); if (row.some(Boolean)) table.push(row);
  const header = table.shift();
  if (!header || !table.length || table.length > 100_000) throw Error('CSV 需包含表头和 1–100000 行回答');
  if (new Set(header).size !== header.length) throw Error('CSV 列名不能重复');
  const matched = questions.filter(q => ['single', 'scale'].includes(q.type) && header.includes(q.id));
  if (!matched.length || matched.length > 10) throw Error('CSV 表头需有 1–10 个单选/量表题 ID，如 q1、q2');
  const targets = matched.map(q => {
    const options = q.type === 'scale' ? Array.from({ length: 10 }, (_, n) => String(n + 1)) : q.options ?? [];
    const counts = new Map(options.map(o => [o, 0])); const index = header.indexOf(q.id);
    table.forEach((row, i) => {
      if (row.length !== header.length || !counts.has(row[index]!)) throw Error(`CSV 第 ${i + 2} 行 ${q.id} 缺失或不属于题目选项`);
      counts.set(row[index]!, counts.get(row[index]!)! + 1);
    });
    return { questionId: q.id, shares: Object.fromEntries([...counts].map(([key, n]) => [key, n / table.length])) };
  });
  return { sampleSize: table.length, targets };
}

export interface CalibrationRow { id: number; answers: SurveyAnswer[] }
export function calibrateWeights(rows: CalibrationRow[], targets: CalibrationTarget[]) {
  const n = rows.length, weights = rows.map(() => 1), warnings: string[] = [];
  const memberships = targets.map(target => Object.keys(target.shares).map(value => rows.flatMap((r, i) => String(r.answers.find(a => a.questionId === target.questionId)?.answer) === value ? [i] : [])));
  const snapshot = () => targets.map((target, t) => {
    const total = weights.reduce((a, b) => a + b, 0);
    const options = Object.entries(target.shares).map(([value, share], c) => {
      const actual = total ? memberships[t]![c]!.reduce((sum, i) => sum + weights[i]!, 0) / total : 0;
      return { value, target: share, actual, deviation: actual - share };
    });
    return { questionId: target.questionId, options, maxDeviation: Math.max(...options.map(o => Math.abs(o.deviation))) };
  });
  const before = snapshot();
  targets.forEach((target, t) => Object.entries(target.shares).forEach(([value, share], c) => {
    if (share > 0 && !memberships[t]![c]!.length) warnings.push(`${target.questionId} 选项「${value}」没有合成样本，无法加权补出缺失观点`);
  }));
  if (n < 5) warnings.push('至少需要 5 份有效合成回答');
  let iterations = 0;
  if (!warnings.length) for (; iterations < 200; iterations++) {
    for (const [t, target] of targets.entries()) {
      const total = weights.reduce((a, b) => a + b, 0);
      for (const [c, share] of Object.values(target.shares).entries()) {
        const members = memberships[t]![c]!, actual = members.reduce((sum, i) => sum + weights[i]!, 0);
        if (actual > 0) for (const i of members) weights[i] = Math.max(0.05, Math.min(20, weights[i]! * share * total / actual));
      }
    }
    // Project onto a bounded simplex so the mean stays 1 without unbounded outliers.
    let low = 0, high = 1000;
    for (let j = 0; j < 45; j++) {
      const factor = (low + high) / 2;
      if (weights.reduce((sum, w) => sum + Math.max(0.05, Math.min(20, w * factor)), 0) > n) high = factor; else low = factor;
    }
    for (let i = 0; i < n; i++) weights[i] = Math.max(0.05, Math.min(20, weights[i]! * (low + high) / 2));
    if (snapshot().every(r => r.maxDeviation < 0.005)) { iterations++; break; }
  }
  const after = snapshot(), total = weights.reduce((a, b) => a + b, 0);
  const effectiveSampleSize = n ? total * total / weights.reduce((sum, w) => sum + w * w, 0) : 0;
  if (after.some(r => r.maxDeviation > 0.02)) warnings.push('校准后最大选项偏差仍超过 2 个百分点，建议增加样本或调整人群');
  if (effectiveSampleSize < Math.max(5, n * 0.2)) warnings.push('有效样本量过低，权重过于集中');
  return { status: warnings.length ? 'failed' as const : 'passed' as const, method: 'bounded-raking-v1', weights: rows.map((r, i) => ({ id: r.id, weight: weights[i]! })), before, after, effectiveSampleSize, iterations, warnings,
    limits: { minWeight: 0.05, maxWeight: 20, maxDeviation: 0.02, minEffectiveRatio: 0.2 } };
}
export type CalibrationResult = ReturnType<typeof calibrateWeights>;
