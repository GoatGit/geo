'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui';
import { SurveyBack, SurveyError, SyntheticNote } from '@/components/surveys/common';

const EXAMPLES = ['探索 399 元便携咖啡机的价格接受度、使用场景与购买顾虑', '了解 25 万元新能源 SUV 潜在用户的需求优先级', '测试面向自由职业者的效率工具，识别付费意愿与关键功能'];
const EXAMPLE_TITLES = ['消费品概念测试', '产品需求排序', '订阅付费意愿'];

/** 新建调研(docs/01 §3.9):单输入框——只问调研目标;标题由规则引擎从目标自动提炼,创建后可改。 */
export default function NewSurveyPage() {
  const router = useRouter(), cache = useQueryClient();
  const [objective, setObjective] = useState('');
  const create = useMutation({ mutationFn: () => api<{ id: number }>('/surveys', { method: 'POST', json: { objective } }),
    onSuccess: s => { void cache.invalidateQueries({ queryKey: ['surveys'] }); router.push(`/surveys/${s.id}`); } });
  return <div className="mx-auto max-w-4xl space-y-6"><SurveyBack /><PageHeader title="新建调研" desc="用一句话说清你想调研什么，标题自动生成。" /><SyntheticNote />
    <form onSubmit={e => { e.preventDefault(); create.mutate(); }} className="card space-y-6 p-6 sm:p-8">
      <label className="block text-sm font-medium">调研目标<textarea autoFocus className="input mt-2 min-h-36 resize-y" required maxLength={2000} value={objective} onChange={e => setObjective(e.target.value)} placeholder="描述产品、目标用户、已知条件，以及你希望通过这次调研回答的问题。" /><span className="mt-1 block text-right text-xs font-normal text-slate-400">{objective.length} / 2000</span></label>
      <div><p className="mb-2 text-xs text-slate-500">从一个示例开始</p><div className="flex flex-wrap gap-2">{EXAMPLES.map((v, i) => <button key={v} type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:bg-brand-50" onClick={() => setObjective(v)}>{EXAMPLE_TITLES[i]}</button>)}</div></div>
      {create.error && <SurveyError error={create.error} />}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-5"><p className="text-xs text-slate-500">标题将自动生成，创建后可在详情页修改。</p><button disabled={!objective.trim() || create.isPending} className="btn-primary">{create.isPending ? '正在保存…' : '创建调研 →'}</button></div>
    </form>
  </div>;
}
