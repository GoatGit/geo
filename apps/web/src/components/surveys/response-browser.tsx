'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState, Skeleton } from '@/components/ui';
import { QUESTION_TYPES } from './types';
import type { SurveyQuestion } from './types';

export interface ResponseItem {
  id: number; personaId: number; status: string; createdAt: string;
  profile: Record<string, unknown>; source: string;
  answers: Array<{ questionId: string; answer: string | number | string[]; comment?: string }>;
}
export interface ResponsesDto { items: ResponseItem[]; total: number; page: number; pageSize: number; questions: SurveyQuestion[]; }

const chip = 'rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500';
const personaName = (p: Record<string, unknown>) => String(p.name ?? p.sampleKey ?? `人物 #${p.id ?? ''}`);
const personaHeadline = (p: Record<string, unknown>) => [p.gender, p.ageBand, p.city, p.occupation].filter(Boolean).join(' · ');

/** 问卷逐条查看:每份答卷 = 一位合成人物对整卷的完整回答,可逐条翻看原文。 */
export function ResponseBrowser({ surveyId, questions }: { surveyId: number; questions: SurveyQuestion[] }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ResponseItem | null>(null);
  const list = useQuery({
    queryKey: ['survey-responses', surveyId, page],
    queryFn: () => api<ResponsesDto>(`/surveys/${surveyId}/responses?page=${page}&pageSize=20`),
  });
  const items = list.data?.items ?? [];
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const qMap = new Map(questions.map(q => [q.id, q]));

  if (selected) {
    const idx = items.findIndex(r => r.id === selected.id);
    const go = (d: number) => setSelected(items[idx + d] ?? null);
    return <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <button className="btn-ghost" onClick={() => setSelected(null)}>← 返回答卷列表</button>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{personaName(selected.profile)}</span>
          <button className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40" disabled={idx <= 0} onClick={() => go(-1)}>上一份</button>
          <button className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40" disabled={idx < 0 || idx >= items.length - 1} onClick={() => go(1)}>下一份</button>
        </div>
      </div>
      <div className="mb-4 rounded-lg bg-slate-50 p-3">
        <p className="text-sm font-medium text-slate-700">{personaName(selected.profile)}<span className="ml-2 text-xs font-normal text-slate-500">{personaHeadline(selected.profile)}</span></p>
        <div className="mt-2 flex flex-wrap gap-1">
          {['cityTier', 'incomeBand', 'occupationGroup', 'familyStage', 'priceSensitivity', 'style'].map(k => selected.profile[k] != null &&
            <span key={k} className={chip}>{String(selected.profile[k])}</span>)}
          {Array.isArray(selected.profile.channels) && <span className={chip}>渠道:{(selected.profile.channels as string[]).join('、')}</span>}
        </div>
      </div>
      <ol className="space-y-4">
        {questions.map((q, i) => {
          const a = selected.answers.find(x => x.questionId === q.id);
          return <li key={q.id} className="border-b border-slate-50 pb-4 last:border-0">
            <p className="text-xs text-slate-400">Q{String(i + 1).padStart(2, '0')} · {QUESTION_TYPES[q.type] ?? q.type}</p>
            <p className="mt-0.5 text-sm font-medium text-slate-700">{q.text}</p>
            {!a ? <p className="mt-2 text-sm text-slate-400">未作答</p>
              : q.type === 'scale' ? <p className="mt-2"><span className="text-2xl font-semibold text-brand-700">{a.answer}</span><span className="ml-1 text-sm text-slate-400">/ 10</span></p>
                : q.type === 'open' ? <blockquote className="mt-2 break-words rounded-lg border-l-2 border-brand-200 bg-slate-50 p-3 text-sm leading-7 text-slate-600">{String(a.answer)}</blockquote>
                  : <div className="mt-2 flex flex-wrap gap-1.5">{(Array.isArray(a.answer) ? a.answer : [a.answer]).map(o =>
                    <span key={String(o)} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">{String(o)}</span>)}</div>}
            {a?.comment && a.comment !== '无' && <p className="mt-2 text-xs leading-6 text-slate-500">「{a.comment}」</p>}
          </li>;
        })}
      </ol>
    </div>;
  }

  return <div className="space-y-3">
    {list.isPending ? <Skeleton /> : list.error ? <p className="text-sm text-bad-600">{(list.error as Error).message}</p>
      : !items.length ? <EmptyState title="还没有答卷" text="作答完成后,这里可以逐条阅读每位人物的完整回答。" />
        : <div className="grid gap-2 sm:grid-cols-2">{items.map(r => (
          <button key={r.id} onClick={() => setSelected(r)}
            className={`rounded-xl border p-3.5 text-left transition-colors hover:border-brand-300 ${r.status === 'completed' ? 'border-slate-100 bg-white' : 'border-warn-100 bg-warn-50/50'}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-slate-800">{personaName(r.profile)}</span>
              {r.status !== 'completed' && <span className="rounded bg-warn-50 px-1.5 py-0.5 text-[11px] text-warn-600">未通过</span>}
            </div>
            {personaHeadline(r.profile) && <p className="mt-0.5 text-xs text-slate-500">{personaHeadline(r.profile)}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {['priceSensitivity', 'style'].map(k => r.profile[k] != null && <span key={k} className={chip}>{String(r.profile[k])}</span>)}
              <span className={chip}>{r.answers.filter(a => qMap.has(a.questionId)).length}/{questions.length} 题有效</span>
            </div>
          </button>))}</div>}
    {list.data && totalPages > 1 && <div className="flex items-center justify-center gap-3 text-xs text-slate-500">
      <button className="btn-ghost disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page} / {totalPages} 页 · 共 {list.data.total} 份</span>
      <button className="btn-ghost disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </div>;
}
