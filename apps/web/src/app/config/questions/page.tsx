'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, brandStore } from '@/lib/api';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';

interface QuestionRow {
  id: number;
  type: 'ranking' | 'reputation';
  textRaw: string;
  textExpanded: string;
  groupName: string | null;
}

interface QuotaDto {
  plan: string;
  ranking: { used: number; limit: number };
  reputation: { used: number; limit: number };
}

/** 监控问题管理(docs/01 §3.2):批量添加 + AI 分类/拓写 + 分池配额条(教训 #4 对策)。 */
export default function QuestionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const brandId = brandStore.get();
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');

  const questions = useQuery({
    queryKey: ['questions', brandId],
    queryFn: () => api<QuestionRow[]>(`/brands/${brandId}/questions`),
    enabled: !!brandId,
  });
  const quota = useQuery({
    queryKey: ['quota', brandId],
    queryFn: () => api<QuotaDto>(`/brands/${brandId}/quota`),
    enabled: !!brandId,
  });

  const batch = useMutation({
    mutationFn: (items: Array<{ text: string }>) =>
      api<{ created: unknown[]; rejected: Array<{ reason: string }>; quota: QuotaDto['ranking'] | unknown }>(
        `/brands/${brandId}/questions:batch`,
        { method: 'POST', json: { items } },
      ),
    onSuccess: (r) => {
      const rejected = (r as { rejected: Array<{ reason: string }> }).rejected ?? [];
      if (rejected.length > 0) toast(`部分未添加:${rejected[0].reason}`, 'err');
      else toast(`已添加 ${(r as { created: unknown[] }).created.length} 个问题,首轮采集已排队`);
      setMessage(
        rejected.length > 0
          ? `部分未添加:${rejected[0].reason}`
          : `已添加 ${(r as { created: unknown[] }).created.length} 个问题,首轮采集已排队`,
      );
      setInput('');
      void qc.invalidateQueries({ queryKey: ['questions'] });
      void qc.invalidateQueries({ queryKey: ['quota'] });
    },
    onError: (e) => {
      toast((e as Error).message, 'err');
      setMessage((e as Error).message);
    },
  });

  if (!brandId) return <Skeleton />;

  const submit = () => {
    const items = input
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((text) => ({ text }));
    if (items.length > 0) batch.mutate(items);
  };

  const q = quota.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="监控问题"
        actions={
          q && (
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <QuotaBar label="排名词" used={q.ranking.used} limit={q.ranking.limit} />
              <QuotaBar label="口碑词" used={q.reputation.used} limit={q.reputation.limit} />
              <span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">{{ free: '免费版', starter: '入门', standard: '标准', pro: '专业', custom: '定制' }[q.plan] ?? q.plan}</span>
            </div>
          )
        }
      />

      <section className="card rise-1 p-6">
        <h2 className="mb-2 text-sm font-medium">批量添加(每行一条,AI 自动分类排名词/口碑词并拓写为自然问法)</h2>
        <textarea
          className="h-32 w-full rounded border p-3 text-sm"
          placeholder={'20万预算纯电轿车推荐\n小米汽车的口碑怎么样?'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            className="rounded bg-brand px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={batch.isPending || !input.trim()}
            onClick={submit}
          >
            添加问题
          </button>
          {message && <span className="text-xs text-slate-500">{message}</span>}
        </div>
      </section>

      <section className="table-wrap rise-2">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="px-4 py-2.5">类型</th>
              <th className="px-4 py-2.5">原文</th>
              <th className="px-4 py-2.5">采集用(拓写)</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {questions.data?.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      row.type === 'ranking' ? 'bg-brand-50 text-brand' : 'bg-blush-50 text-blush-700'
                    }`}
                  >
                    {row.type === 'ranking' ? '排名词' : '口碑词'}
                  </span>
                </td>
                <td className="max-w-64 truncate px-4 py-2.5">{row.textRaw}</td>
                <td className="max-w-80 truncate px-4 py-2.5 text-slate-500">{row.textExpanded}</td>
                <td className="px-3 py-2.5">
                  <button
                    className="text-xs text-bad hover:underline"
                    onClick={() =>
                      api(`/brands/${brandId}/questions/${row.id}`, { method: 'DELETE' })
                        .then(() => {
                          toast('问题已归档,历史数据保留');
                          qc.invalidateQueries({ queryKey: ['questions'] });
                        })
                        .catch((e) => toast((e as Error).message, 'err'))
                    }
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {questions.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  还没有监控问题
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? used / limit : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span>{label}</span>
      <div className="h-1.5 w-20 rounded bg-slate-100">
        <div
          className={`h-1.5 rounded ${ratio >= 1 ? 'bg-bad' : ratio >= 0.8 ? 'bg-warn' : 'bg-brand'}`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <span className="metric-num">
        {used}/{limit}
      </span>
    </div>
  );
}
