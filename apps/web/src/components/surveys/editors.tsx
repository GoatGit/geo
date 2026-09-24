'use client';
import { SURVEY_DIMENSIONS, validateSurveyQuestions, validateSurveySegments } from '@geo/shared';
import { QUESTION_TYPES, type SurveyQuestion, type SurveySegment } from './types';

export function QuestionEditor({ value, onChange, disabled }: { value: SurveyQuestion[]; onChange: (v: SurveyQuestion[]) => void; disabled: boolean }) {
  const edit = (index: number, change: Partial<SurveyQuestion>) => onChange(value.map((q, i) => i === index ? { ...q, ...change } : q));
  const move = (index: number, to: number) => { const next = value.slice(); [next[index], next[to]] = [next[to]!, next[index]!]; onChange(next); };
  const check = validateSurveyQuestions(value);
  return <div className="space-y-4">
    {value.map((q, i) => <fieldset disabled={disabled} key={q.id} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <legend className="px-1 text-xs font-medium text-brand-700">问题 {String(i + 1).padStart(2, '0')}</legend>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><label><span className="sr-only">第 {i + 1} 题题型</span><select className="input !w-auto" value={q.type} onChange={e => { const type = e.target.value as SurveyQuestion['type']; edit(i, { type, options: ['single', 'multi'].includes(type) ? q.options ?? ['选项一', '选项二'] : undefined }); }}>{Object.entries(QUESTION_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {!disabled && <div className="flex gap-1"><button type="button" className="btn-ghost !px-2 !py-1 text-xs" aria-label={`上移第 ${i + 1} 题`} disabled={i === 0} onClick={() => move(i, i - 1)}>上移</button><button type="button" className="btn-ghost !px-2 !py-1 text-xs" aria-label={`下移第 ${i + 1} 题`} disabled={i === value.length - 1} onClick={() => move(i, i + 1)}>下移</button><button type="button" className="btn-ghost !px-2 !py-1 text-xs" aria-label={`删除第 ${i + 1} 题`} onClick={() => onChange(value.filter((_, index) => index !== i))}>删除</button></div>}</div>
      <label className="block text-xs text-slate-500">题目<textarea aria-label={`第 ${i + 1} 题题目`} className="input mt-2 min-h-20 resize-y" maxLength={200} value={q.text} onChange={e => edit(i, { text: e.target.value })} /></label>
      {q.options && <div className="mt-4 space-y-2">{q.options.map((option, j) => <div key={j} className="flex items-center gap-2"><span className="w-5 shrink-0 text-xs text-slate-400">{String.fromCharCode(65 + j)}</span><input aria-label={`第 ${i + 1} 题选项 ${j + 1}`} className="input" maxLength={100} value={option} onChange={e => edit(i, { options: q.options!.map((o, n) => n === j ? e.target.value : o) })} />{!disabled && <button type="button" className="shrink-0 px-2 text-sm text-slate-500" aria-label={`删除第 ${i + 1} 题选项 ${j + 1}`} disabled={q.options!.length <= 2} onClick={() => edit(i, { options: q.options!.filter((_, n) => n !== j) })}>移除</button>}</div>)}{!disabled && q.options.length < 10 && <button type="button" className="mt-2 text-xs font-medium text-brand-700" onClick={() => edit(i, { options: [...q.options!, ''] })}>＋ 添加选项</button>}</div>}
      {q.type === 'scale' && <div className="mt-4"><div className="flex justify-between gap-1">{Array.from({ length: 10 }, (_, n) => <span key={n} className="flex h-8 flex-1 items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-500">{n + 1}</span>)}</div><p className="mt-2 text-xs text-slate-500">固定 1–10 分，请在题目中明确低分和高分含义。</p></div>}
      {q.type === 'open' && <p className="mt-3 text-xs text-slate-500">每位合成人物将独立给出简短文字回答。</p>}
    </fieldset>)}
    {!disabled && <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" className="btn-ghost" disabled={value.length >= 20} onClick={() => onChange([...value, { id: `q${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, type: 'single', text: '', options: ['选项一', '选项二'] }])}>＋ 添加问题</button><span className="text-xs text-slate-500">{value.length} / 20 题</span></div>}
    {!disabled && value.length > 0 && !check.ok && <p role="status" className="text-xs leading-6 text-bad-600">{check.errors[0]}</p>}
  </div>;
}

export const DEFAULT_SEGMENT: SurveySegment = { ageBand: '25-34', cityTier: '二线', incomeBand: '10-20万', gender: '不限', occupationGroup: '企业职员', count: 20 };
export function SegmentEditor({ value, onChange, disabled }: { value: SurveySegment[]; onChange: (v: SurveySegment[]) => void; disabled: boolean }) {
  const total = value.reduce((n, s) => n + s.count, 0);
  const check = validateSurveySegments(value);
  return <div className="space-y-4">{value.map((seg, i) => <fieldset key={i} disabled={disabled} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><legend className="px-1 text-xs font-medium text-brand-700">人群 {i + 1}</legend><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(SURVEY_DIMENSIONS).map(([key, label]) => <label key={key} className="text-xs text-slate-500">{label}<input aria-label={`人群 ${i + 1} ${label}`} className="input mt-1.5" maxLength={80} value={seg[key as keyof Omit<SurveySegment, 'count'>]} onChange={e => onChange(value.map((s, n) => n === i ? { ...s, [key]: e.target.value } : s))} /></label>)}<label className="text-xs text-slate-500">样本量<input aria-label={`人群 ${i + 1} 样本量`} type="number" min={1} max={2000} step={1} className="input mt-1.5" value={seg.count || ''} onChange={e => onChange(value.map((s, n) => n === i ? { ...s, count: Number(e.target.value) } : s))} /></label></div>
      <div className="mt-4 flex items-center justify-between"><span className="text-xs text-slate-500">占总样本 {total > 0 ? Math.round(seg.count / total * 100) : 0}%</span>{!disabled && <button type="button" className="text-xs text-slate-500 hover:text-bad-600" onClick={() => onChange(value.filter((_, n) => n !== i))}>删除人群 {i + 1}</button>}</div>
    </fieldset>)}
    {!disabled && <button type="button" className="btn-ghost" disabled={value.length >= 20} onClick={() => onChange([...value, { ...DEFAULT_SEGMENT }])}>＋ 添加人群</button>}
    {value.length > 0 && <div className="rounded-xl bg-brand-50 p-4"><div className="mb-2 flex justify-between text-sm"><span>计划样本量</span><strong className="tabular-nums">{total.toLocaleString()} 人</strong></div><div className="flex h-2 overflow-hidden rounded-full bg-brand-100">{value.map((s, i) => <span key={i} className={i % 2 ? 'bg-brand-300' : 'bg-brand-600'} style={{ width: `${total ? s.count / total * 100 : 0}%` }} />)}</div><p className="mt-2 text-xs text-slate-500">建议先用 20–50 人检查问卷，再增加样本。每份调研最多 2000 人。</p></div>}
    {!disabled && value.length > 0 && !check.ok && <p role="status" className="text-xs text-bad-600">{check.errors[0]}</p>}
  </div>;
}
