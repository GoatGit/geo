'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState, Skeleton } from '@/components/ui';
import type { SurveySegment } from './types';

/** profile 中用户可读字段的中文标签(未列出的键按原文展示)。 */
const FIELD_LABELS: Record<string, string> = {
  name: '姓名', gender: '性别', ageBand: '年龄段', city: '常住城市', cityTier: '城市层级',
  incomeBand: '收入档', occupationGroup: '职业大类', occupation: '具体职业', familyStage: '家庭状况',
  channels: '信息渠道', priceSensitivity: '价格敏感度', style: '决策风格', consumptionNote: '消费习惯',
  headline: '速览', description: '人物描述', sampleKey: '样本编号',
};
const HIDDEN_KEYS = new Set(['provenance']);
const asText = (v: unknown) => Array.isArray(v) ? v.join('、') : String(v);

export interface PersonaItem { id: number; profile: Record<string, unknown>; source: string; weight: number; libraryId: number | null; }
export interface PersonasDto { items: PersonaItem[]; total: number; page: number; pageSize: number; }

/** 人群逐条查看:确认人群前先点名审阅——每位人物都是一份完整档案,支持逐条翻看。 */
export function PersonaBrowser({ surveyId, poolId, segments }: { surveyId: number; poolId: number; segments: SurveySegment[] }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PersonaItem | null>(null);
  const list = useQuery({
    queryKey: ['survey-personas', surveyId, poolId, page],
    queryFn: () => api<PersonasDto>(`/surveys/${surveyId}/pools/${poolId}/personas?page=${page}&pageSize=20`),
  });
  const items = list.data?.items ?? [];
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  if (selected) {
    const idx = items.findIndex(p => p.id === selected.id);
    const go = (d: number) => setSelected(items[idx + d] ?? null);
    return <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <button className="btn-ghost" onClick={() => setSelected(null)}>← 返回名单</button>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>样本 {String(selected.profile.sampleKey ?? selected.id)}</span>
          <button className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40" disabled={idx <= 0} onClick={() => go(-1)}>上一条</button>
          <button className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40" disabled={idx < 0 || idx >= items.length - 1} onClick={() => go(1)}>下一条</button>
        </div>
      </div>
      <h3 className="text-lg font-semibold">{String(selected.profile.name ?? `人物 #${selected.id}`)}</h3>
      {typeof selected.profile.headline === 'string' && <p className="mt-1 text-sm text-slate-500">{selected.profile.headline}</p>}
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {Object.entries(selected.profile).filter(([k, v]) => v != null && !HIDDEN_KEYS.has(k)).map(([k, v]) => (
          <div key={k} className={k === 'description' || k === 'consumptionNote' ? 'sm:col-span-2' : ''}>
            <dt className="text-xs text-slate-400">{FIELD_LABELS[k] ?? k}</dt>
            <dd className="mt-0.5 break-words text-sm leading-6 text-slate-700">{asText(v)}</dd>
          </div>
        ))}
      </dl>
      {selected.source === 'persona_hub' && <p className="mt-4 rounded-lg bg-sand-50 p-3 text-xs leading-6 text-slate-500">该人物来自 Persona Hub 共享档案;配额维度为研究赋值,不是其真实人口资料。</p>}
    </div>;
  }

  return <div className="space-y-3">
    {list.isPending ? <Skeleton /> : list.error ? <p className="text-sm text-bad-600">{(list.error as Error).message}</p>
      : !items.length ? <EmptyState title="这个人群方案还没有人物" text="保存配额方案后会按配额生成人物档案。" />
        : <div className="grid gap-2 sm:grid-cols-2">{items.map(p => (
          <button key={p.id} onClick={() => setSelected(p)}
            className="rounded-xl border border-slate-100 bg-white p-3.5 text-left transition-colors hover:border-brand-300">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-slate-800">{String(p.profile.name ?? `人物 #${p.id}`)}</span>
              <span className="text-[11px] text-slate-400">{String(p.profile.sampleKey ?? '')}</span>
            </div>
            {typeof p.profile.headline === 'string' && <p className="mt-0.5 text-xs text-slate-500">{p.profile.headline}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {['gender', 'ageBand', 'cityTier', 'incomeBand', 'occupationGroup'].map(k => p.profile[k] != null &&
                <span key={k} className="rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">{String(p.profile[k])}</span>)}
              {p.source === 'persona_hub' && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand-700">Hub</span>}
            </div>
          </button>))}</div>}
    {list.data && totalPages > 1 && <div className="flex items-center justify-center gap-3 text-xs text-slate-500">
      <button className="btn-ghost disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page} / {totalPages} 页 · 共 {list.data.total} 人</span>
      <button className="btn-ghost disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
    <p className="text-xs leading-6 text-slate-400">配额构成:{segments.map(s => `${[s.gender, s.ageBand, s.cityTier, s.incomeBand, s.occupationGroup].join('·')}×${s.count}`).join('  ')}</p>
  </div>;
}
