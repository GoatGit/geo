'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState, Skeleton } from '@/components/ui';
import { SurveyError } from './common';
interface LibraryRow {
  id: number; description: string; profile: Record<string, unknown> | null; status: string;
  sourceUrl: string; license: string; parserVersion: string | null; lastError: string | null;
}
interface LibraryData {
  rows: LibraryRow[];
  counts: { total: number; ready: number; pending: number; failed: number; imported: number };
  jobs: unknown[]; hasMore: boolean; allowed: boolean; license: string; sourceRevision: string; sourceUrl: string;
}
const TRAIT_CHIPS = ['occupation', 'occupationGroup', 'ageBand', 'cityTier', 'incomeBand', 'gender'] as const;

/** 人群性格 · 职业库:纯粹的全库结构化人物列表 + 检索。导入/增强等建设操作不在本页。 */
export function PersonaLibraryPanel() {
  const [q, setQ] = useState(''), [offset, setOffset] = useState(0);
  const data = useQuery({
    queryKey: ['persona-library', q, offset],
    queryFn: () => api<LibraryData>(`/persona-library?q=${encodeURIComponent(q)}&offset=${offset}&status=ready`),
    refetchInterval: query => query.state.data?.counts.pending ? 5000 : false,
  });
  if (data.isPending) return <Skeleton />;
  if (data.error || !data.data) return <SurveyError error={data.error ?? new Error('人群库读取失败')} retry={() => void data.refetch()} />;
  const library = data.data;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold">全库人物（{library.counts.ready}）</h2>
      <label className="text-xs text-slate-500">检索人物<input className="input mt-1" aria-label="检索人物" placeholder="如：教师、软件工程师、谨慎" value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} /></label>
    </div>
    {!library.rows.length ? <EmptyState title={q ? '没有匹配的人物' : '人群库建设中'} text={q ? '换个关键词试试，可按职业、性格或城市检索。' : '人物由离线批量结构化生成，完成后全库在这里可查、可选、可抽样。'} /> : <div className="grid gap-4 lg:grid-cols-2">{library.rows.map(row => { const profile = row.profile; return <article key={row.id} className="card p-5">
      <div className="flex flex-wrap gap-1.5">{TRAIT_CHIPS.filter(k => profile?.[k] != null).map(k => <span key={k} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">{String(profile[k])}</span>)}</div>
      {Array.isArray(profile?.traits) && profile.traits.length > 0 && <p className="mt-3 text-sm leading-7 text-slate-700">性格：{profile.traits.join('、')}</p>}
    </article>; })}</div>}
    <div className="flex items-center justify-between"><button className="btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><span className="text-xs text-slate-400">第 {Math.floor(offset / 30) + 1} 页</span><button className="btn-ghost" disabled={!library.hasMore} onClick={() => setOffset(offset + 30)}>下一页</button></div>
  </div>;
}
