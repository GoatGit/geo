'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState, PageHeader, SearchInput, Skeleton } from '@/components/ui';
import { SurveyError, SurveyStatus, SyntheticNote } from '@/components/surveys/common';
import { busySurvey, type SurveyRow } from '@/components/surveys/types';

export default function SurveysPage() {
  const [search, setSearch] = useState('');
  const surveys = useQuery({ queryKey: ['surveys'], queryFn: () => api<SurveyRow[]>('/surveys'),
    refetchInterval: q => q.state.data?.some(s => busySurvey(s.status)) ? 3000 : false });
  const rows = surveys.data ?? [];
  const filtered = rows.filter(s => `${s.title} ${s.objective}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-6">
    <PageHeader title="超级问卷" desc="把一个产品问题，变成可验证的研究假设。" actions={<Link href="/surveys/new" className="btn-primary">＋ 新建调研</Link>} />
    <section className="overflow-hidden rounded-2xl border border-brand-200 bg-brand-50 p-6 sm:p-8">
      <p className="mb-3 text-xs font-medium tracking-[.16em] text-brand-700">从问题到洞察</p>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><h2 className="text-2xl font-semibold tracking-tight text-slate-800">先听见不同的声音，再做下一步决定。</h2><p className="mt-3 max-w-xl text-sm leading-7 text-slate-600">设计问卷、选择人群、独立作答，保留每一步的判断权。适用于概念测试、定价探索和需求发现。</p></div>
      <dl className="flex shrink-0 gap-8"><div><dt className="text-xs text-slate-500">调研项目</dt><dd className="mt-2 text-3xl font-semibold tabular-nums">{rows.length}</dd></div><div><dt className="text-xs text-slate-500">已出结果</dt><dd className="mt-2 text-3xl font-semibold tabular-nums text-brand-700">{rows.filter(s => ['completed', 'partial'].includes(s.status)).length}</dd></div></dl></div>
    </section>
    <SyntheticNote />
    <div className="flex items-center justify-between gap-4"><h2 className="text-base font-semibold">我的调研</h2><label className="w-full max-w-xs"><span className="sr-only">搜索调研</span><SearchInput ariaLabel="搜索调研" placeholder="搜索标题或调研目标" className="input" onSearch={setSearch} /></label></div>
    {surveys.isPending ? <Skeleton /> : surveys.error ? <SurveyError error={surveys.error} retry={() => void surveys.refetch()} /> : !rows.length ? <EmptyState title="从你的第一个问题开始" text="例如：用户愿意为便携咖啡机支付多少？哪些顾虑会影响购买？" action={<Link href="/surveys/new" className="btn-primary">创建第一份调研</Link>} /> : !filtered.length ? <EmptyState title="没有找到匹配调研" text="换个关键词试试。" /> : <div className="grid gap-4 lg:grid-cols-2">{filtered.map(s => <article key={s.id} className="card flex flex-col p-5 sm:p-6"><div className="mb-3 flex items-start justify-between gap-3"><Link href={`/surveys/${s.id}`} className="min-w-0 text-lg font-semibold text-slate-800 hover:text-brand-700">{s.title}{s.isDemo && <span className="ml-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 align-middle text-[10px] font-medium text-slate-500">示例</span>}</Link><SurveyStatus status={s.status} /></div><p className="mb-5 line-clamp-2 text-sm leading-6 text-slate-500">{s.objective}</p><div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><span className="text-xs text-slate-500">{s.questions.length} 道题 · {new Date(s.updatedAt).toLocaleDateString('zh-CN')}</span><div className="flex gap-3">{['completed', 'partial'].includes(s.status) && <Link href={`/surveys/reports?surveyId=${s.id}`} className="text-sm font-medium text-brand-700">查看报告</Link>}<Link href={`/surveys/${s.id}`} className="text-sm text-slate-600">{busySurvey(s.status) ? '查看进度' : s.status === 'completed' ? '调研详情' : '继续调研'} →</Link></div></div></article>)}</div>}
  </div>;
}
