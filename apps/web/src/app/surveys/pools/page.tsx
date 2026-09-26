'use client';
import Link from 'next/link';
import { PersonaLibraryPanel } from '@/components/surveys/persona-library';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { SurveyError, SyntheticNote } from '@/components/surveys/common';
import type { SurveyPool } from '@/components/surveys/types';

export default function PoolsPage() {
  const [tab, setTab] = useState('library');
  const [filter, setFilter] = useState('active');
  const pools = useQuery({ queryKey: ['survey-pools'], queryFn: () => api<SurveyPool[]>('/surveys-pools') });
  const rows = (pools.data ?? []).filter(p => filter === 'all' || p.active);
  return <div className="mx-auto max-w-6xl space-y-6"><PageHeader title="人群库" desc="查看各次调研的样本配额，追溯当前方案与历史版本。" actions={<Link className="btn-primary" href="/surveys/new">新建调研</Link>} /><SyntheticNote /><nav className="flex gap-2" aria-label="人群库视图"><button className={tab === 'library' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('library')}>人群性格 · 职业库</button><button className={tab === 'pools' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('pools')}>调研人群方案</button></nav>{tab === 'library' ? <PersonaLibraryPanel /> : <>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-500">配额方案 · 人物来源 · 校准状态</p><label className="flex items-center gap-2 text-sm text-slate-600">显示范围<select className="input w-auto" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">当前使用的人群</option><option value="all">全部方案（含历史）</option></select></label></div>
    {pools.isPending ? <Skeleton /> : pools.error ? <SurveyError error={pools.error} retry={() => void pools.refetch()} /> : !rows.length ? <EmptyState title="还没有人群方案" text="创建调研并保存问卷后，即可选择目标人群和样本量。" /> : <div className="grid gap-4 lg:grid-cols-2">{rows.map(p => <article key={p.id} className="card flex flex-col p-5 sm:p-6"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-slate-400">人群方案 #{p.id}</span><Badge tone={p.active ? 'brand' : 'slate'} label={p.active ? '当前方案' : '历史方案'} /><Badge tone={p.approved ? 'good' : 'slate'} label={p.approved ? '已确认' : '未确认'} /></div><h2 className="mt-3 break-words text-lg font-semibold">{p.surveyTitle}</h2><p className="mt-2 text-sm text-slate-500"><strong className="text-2xl font-semibold text-slate-800">{p.size}</strong> 位合成人物 · {p.spec.segments.length} 组配额</p>{!!p.sourceStats?.personaHub && <p className="mt-2 text-xs text-slate-500">Persona Hub {p.sourceStats.personaHub} 人 · {p.sourceStats.uniqueLibrary} 个不同来源档案</p>}<ul className="my-5 flex-1 space-y-2">{p.spec.segments.map((s, i) => <li key={i} className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-xs leading-6"><span className="min-w-0 flex-1 text-slate-600">{[s.gender, s.ageBand, s.cityTier, s.incomeBand, s.occupationGroup].join(' · ')}</span><span className="shrink-0 font-semibold text-brand-800">{s.count} 人</span></li>)}</ul><div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><span className="w-full text-xs text-slate-400 sm:w-auto">来源：{p.sourceMode === 'persona_hub' ? 'Persona Hub' : p.sourceMode === 'hybrid' ? '混合人物' : '配额生成'} / {p.calibrationStatus === 'passed' ? '已应用真人校准' : p.calibrationStatus === 'failed' ? '校准未达标' : '未校准'}</span><Link className="text-xs text-brand-700" href={`/surveys/reports?surveyId=${p.surveyId}#calibration`}>真人校准</Link><Link className="text-sm font-medium text-brand-700 hover:underline" href={`/surveys/${p.surveyId}?step=audience`}>查看调研 →</Link></div></article>)}</div>}
  </>}</div>;
}
