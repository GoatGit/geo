'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isAdmin } from '@/lib/api';
import { Badge, EmptyState, Skeleton } from '@/components/ui';
import { SurveyError } from './common';
interface LibraryRow {
  id: number; description: string; profile: Record<string, unknown> | null; status: string;
  sourceUrl: string; license: string; parserVersion: string | null; lastError: string | null;
}
interface LibraryData {
  rows: LibraryRow[];
  counts: { total: number; ready: number; pending: number; failed: number; imported: number };
  jobs: Array<{ id: number; status: string; requestedCount: number; processed: number; imported: number; lastError: string | null }>;
  hasMore: boolean; allowed: boolean; license: string; sourceRevision: string; sourceUrl: string;
}
const STATUS: Record<string, string> = { imported: '已导入', queued: '等待增强', enriching: '增强中', ready: '可抽样', failed: '需重试', completed: '已完成', running: '导入中' };
const TRAIT_CHIPS = ['occupation', 'occupationGroup', 'ageBand', 'cityTier', 'incomeBand', 'gender'] as const;

/** 人群性格·职业库(结构化视图):只展示增强完成的档案;原始源材料与管理操作收进管理区。 */
export function PersonaLibraryPanel() {
  const cache = useQueryClient();
  const [q, setQ] = useState(''), [offset, setOffset] = useState(0);
  const [adminView, setAdminView] = useState(false);
  const listStatus = adminView ? '' : 'ready';
  const data = useQuery({
    queryKey: ['persona-library', q, offset, listStatus],
    queryFn: () => api<LibraryData>(`/persona-library?q=${encodeURIComponent(q)}&offset=${offset}&status=${listStatus}`),
    refetchInterval: query => query.state.data?.counts.pending ? 3000 : false,
  });
  const action = useMutation({
    mutationFn: ({ path, count }: { path: string; count?: number }) => api(`/persona-library/${path}`, { method: 'POST', json: { count } }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['persona-library'] }),
  });
  if (data.isPending) return <Skeleton />;
  if (data.error || !data.data) return <SurveyError error={data.error ?? new Error('人群库读取失败')} retry={() => void data.refetch()} />;
  const library = data.data;
  const enriching = library.counts.pending > 0;
  return <div className="space-y-5">
    <section className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-lg font-semibold">人群性格 · 职业库</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500">全部由源描述离线结构化而来：职业与性格为中文提取结果，原文没有的人口属性保持未知，抽样时再用你确认的配额赋值。调研「人物来源」选 Persona Hub 时，即从本库抽样。</p></div>
        <a href="https://github.com/tencent-ailab/persona-hub" target="_blank" rel="noreferrer" className="text-xs text-brand-700 underline">原始数据与许可 ↗</a>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">{[['可抽样（已增强）', library.counts.ready], ['增强队列中', library.counts.pending], ['待增强源描述', library.counts.imported], ['需重试', library.counts.failed]].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd></div>)}</dl>
      {enriching && <p className="mt-4 rounded-lg bg-brand-50 p-3 text-xs leading-6 text-brand-800" role="status">离线批量增强进行中（worker 6 路并发，每条一次模型调用）——完成后自动进入「可抽样」，本页实时刷新。</p>}
      <p className="mt-4 text-xs leading-6 text-slate-500">数据许可：{library.license}（非商业使用）；当前{library.allowed ? '已配置授权记录' : '未取得商业授权，导入与增强停用——生产启用需设置 PERSONA_HUB_COMMERCIAL_LICENSE_REF'}。上游版本 {library.sourceRevision.slice(0, 12)}。增强为模型提取，使用前建议抽检。</p>
      {isAdmin() && <div className="mt-5 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-5">
        <button className="btn-primary" disabled={!library.allowed || action.isPending || !library.counts.total} onClick={() => { if (window.confirm(`把 ${library.counts.imported + library.counts.failed} 条未增强/需重试的源描述全部入队离线增强？按 6 路并发估算，量大时需要数天与相应模型额度。`)) action.mutate({ path: 'enrich-all' }); }}>全部增强（离线跑批）</button>
        <button className="btn-soft" disabled={!library.allowed || action.isPending || !library.counts.failed} onClick={() => action.mutate({ path: 'enrich', count: 500 })}>重试失败项（≤500）</button>
        {action.isSuccess && <span className="self-center text-xs text-good-700">已入队 {String((action.data as { queued?: number }).queued ?? 0)} 条</span>}
      </div>}
      {!isAdmin() && !library.counts.ready && <p className="mt-4 text-sm text-slate-500">人群库正在建设中，请联系平台管理员导入并增强人物。</p>}
      {action.error && <div className="mt-4"><SurveyError error={action.error} /></div>}
      {library.jobs.length > 0 && <details className="mt-5"><summary className="cursor-pointer text-xs text-slate-500">导入任务记录</summary><ul className="mt-3 space-y-2 text-xs text-slate-600">{library.jobs.map(j => <li key={j.id}>#{j.id} {STATUS[j.status] ?? j.status} · 读取 {j.processed}/{j.requestedCount} · 新增 {j.imported}{j.lastError ? ` · ${j.lastError}` : ''}</li>)}</ul></details>}
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold">{adminView ? '原始源材料（排查用）' : '结构化人物'}</h2>
      <div className="flex items-center gap-3">
        <label className="text-xs text-slate-500">检索{adminView ? '原文' : '职业/描述'}<input className="input mt-1" aria-label="检索人物" placeholder={adminView ? 'engineer、teacher' : '教师、软件工程师'} value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} /></label>
        {isAdmin() && <button className={adminView ? 'btn-primary' : 'btn-ghost'} onClick={() => { setAdminView(!adminView); setOffset(0); }}>{adminView ? '返回结构化视图' : '查看原始源材料'}</button>}
      </div>
    </div>
    {!library.rows.length ? <EmptyState title={q ? '没有匹配的档案' : adminView ? '尚未导入人物档案' : '还没有增强完成的人物'} text={q ? '换个关键词试试。' : adminView ? '在上方导入 Persona Hub 源数据。' : '点击「全部增强」开始离线批量转化，完成后这里就是全库中文人群。'} /> : <div className="grid gap-4 lg:grid-cols-2">{library.rows.map(row => { const profile = row.profile; return <article key={row.id} className="card p-5">
      <div className="flex items-center justify-between"><span className="text-xs text-slate-400">Persona #{row.id}</span><Badge label={STATUS[row.status] ?? row.status} tone={row.status === 'ready' ? 'good' : row.status === 'failed' ? 'warn' : 'slate'} /></div>
      {profile ? <>
        <div className="mt-3 flex flex-wrap gap-1.5">{TRAIT_CHIPS.filter(k => profile[k] != null).map(k => <span key={k} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">{String(profile[k])}</span>)}</div>
        {Array.isArray(profile.traits) && profile.traits.length > 0 && <p className="mt-3 text-sm leading-7 text-slate-700">性格：{profile.traits.join('、')}</p>}
        <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-400">原始描述</summary><p className="mt-2 break-words text-xs leading-6 text-slate-500">{row.description}</p></details>
      </> : <>
        <p className="mt-3 break-words text-sm leading-7 text-slate-700">{row.description}</p>
        {row.status === 'imported' && <p className="mt-3 text-xs leading-6 text-slate-400">未增强源描述——增强后进入结构化库。</p>}
      </>}
      {row.lastError && <p className="mt-3 text-xs text-warn-600">{row.lastError}</p>}
    </article>; })}</div>}
    <div className="flex items-center justify-between"><button className="btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><span className="text-xs text-slate-400">第 {Math.floor(offset / 30) + 1} 页</span><button className="btn-ghost" disabled={!library.hasMore} onClick={() => setOffset(offset + 30)}>下一页</button></div>
  </div>;
}
