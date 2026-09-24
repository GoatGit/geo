'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui';
import { SurveyBack, SurveyError, SyntheticNote } from '@/components/surveys/common';

const EXAMPLES = ['探索 399 元便携咖啡机的价格接受度、使用场景与购买顾虑', '了解 25 万元新能源 SUV 潜在用户的需求优先级', '测试面向自由职业者的效率工具，识别付费意愿与关键功能'];
export default function NewSurveyPage() {
  const router = useRouter(), cache = useQueryClient();
  const [title, setTitle] = useState(''), [objective, setObjective] = useState(''), [brandId, setBrandId] = useState('');
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api<Array<{ id: number; name: string }>>('/brands') });
  const create = useMutation({ mutationFn: () => api<{ id: number }>('/surveys', { method: 'POST', json: { title, objective, ...(brandId ? { brandId: Number(brandId) } : {}) } }),
    onSuccess: s => { void cache.invalidateQueries({ queryKey: ['surveys'] }); router.push(`/surveys/${s.id}`); } });
  return <div className="mx-auto max-w-4xl space-y-6"><SurveyBack /><PageHeader title="新建调研" desc="先说清你要做什么决定，再决定向谁提问。" /><SyntheticNote />
    <form onSubmit={e => { e.preventDefault(); create.mutate(); }} className="card space-y-6 p-6 sm:p-8">
      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]"><label className="text-sm font-medium">调研标题<input className="input mt-2" required maxLength={120} placeholder="例如：便携咖啡机定价与需求探索" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="text-sm font-medium">关联品牌 <span className="font-normal text-slate-400">（可选）</span><select className="input mt-2" value={brandId} onChange={e => setBrandId(e.target.value)}><option value="">独立调研</option>{brands.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label></div>
      <label className="block text-sm font-medium">调研目标<textarea className="input mt-2 min-h-36 resize-y" required maxLength={2000} value={objective} onChange={e => setObjective(e.target.value)} placeholder="描述产品、目标用户、已知条件，以及你希望通过这次调研回答的问题。" /><span className="mt-1 block text-right text-xs font-normal text-slate-400">{objective.length} / 2000</span></label>
      <div><p className="mb-2 text-xs text-slate-500">从一个示例开始</p><div className="flex flex-wrap gap-2">{EXAMPLES.map((v, i) => <button key={v} type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:bg-brand-50" onClick={() => { setObjective(v); if (!title) setTitle(['咖啡机定价探索', '新能源 SUV 需求探索', '效率工具付费意愿'][i]!); }}>{['消费品概念测试', '产品需求排序', '订阅付费意愿'][i]}</button>)}</div></div>
      {create.error && <SurveyError error={create.error} />}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-5"><p className="text-xs text-slate-500">先保存草稿，随后可生成或手动设计问卷。</p><button disabled={!title.trim() || !objective.trim() || create.isPending} className="btn-primary">{create.isPending ? '正在保存…' : '创建调研 →'}</button></div>
    </form>
  </div>;
}
