'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useBrandId } from '@/lib/queries';
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
  const brandId = useBrandId();
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  // AI 推荐问题:候选展示 → 勾选 → 加入输入框走既有批量链路(分类/拓写/配额校验一致)
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ text: string; type: string; picked: boolean }> | null>(null);
  const [suggestErr, setSuggestErr] = useState('');

  const runSuggest = async () => {
    setSuggesting(true);
    setSuggestErr('');
    setSuggestions(null);
    try {
      const r = await api<Array<{ text: string; type: string }>>(
        `/brands/${brandId}/questions:suggest`,
        { method: 'POST', json: { count: 12 } },
      );
      setSuggestions(r.map((x) => ({ ...x, picked: true })));
      if (r.length === 0) setSuggestErr('AI 未产出新问题(可能已有问题覆盖较全),可补充品牌档案后重试');
    } catch (e) {
      setSuggestErr((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const adoptPicked = () => {
    const picked = (suggestions ?? []).filter((x) => x.picked).map((x) => x.text);
    if (picked.length === 0) return;
    setInput((prev) => [...prev.split('\n').filter(Boolean), ...picked].join('\n'));
    setSuggestions(null);
    toast(`已加入 ${picked.length} 条到输入框,确认后点「添加问题」`);
  };

  const questions = useQuery({
    queryKey: ['questions', brandId],
    queryFn: () => api<QuestionRow[]>(`/brands/${brandId}/questions`),
    enabled: !!brandId,
  });
  // 语义层惰性兜底的可视化:页面加载 3 秒后若有「分层待定」项,自动刷新一次
  // (list 请求已触发服务端后台补层,这里只是把结果取回来)
  useEffect(() => {
    if (!questions.data?.some((r) => !r.groupName)) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: ['questions', brandId] }), 3000);
    return () => clearTimeout(t);
  }, [questions.data, brandId, qc]);
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">批量添加(每行一条,AI 自动分类排名词/口碑词并拓写为自然问法)</h2>
          <button
            className="rounded-lg border border-brand/30 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 transition-colors hover:border-brand/50 disabled:opacity-50"
            disabled={suggesting}
            onClick={() => void runSuggest()}
            title="基于品牌档案、竞品清单与已有问题,AI 生成差异化的新监控问题"
          >
            {suggesting ? 'AI 生成中…(约 10-20s)' : '✦ AI 推荐问题'}
          </button>
        </div>
        {suggestErr && <p className="mb-2 text-xs text-bad">{suggestErr}</p>}
        {suggestions && (
          <div className="mb-3 rounded-xl border border-brand/20 bg-brand-50/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-700">AI 推荐({suggestions.filter((x) => x.picked).length}/{suggestions.length} 已选,取消勾选可排除)</p>
              <div className="flex gap-2">
                <button className="btn-primary h-7 px-3 text-xs" onClick={adoptPicked}>加入输入框</button>
                <button className="h-7 px-2 text-xs text-slate-500 hover:text-slate-800" onClick={() => setSuggestions(null)}>关闭</button>
              </div>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {suggestions.map((x, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-100 bg-white px-2.5 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={x.picked}
                    onChange={() => setSuggestions((prev) => (prev ?? []).map((y, j) => (j === i ? { ...y, picked: !y.picked } : y)))}
                  />
                  <span className={x.type === 'reputation' ? 'text-teal-700' : 'text-brand-700'}>
                    {x.type === 'reputation' ? '口碑' : '排名'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-700" title={x.text}>{x.text}</span>
                </label>
              ))}
            </div>
          </div>
        )}
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
                    className={`mr-1.5 rounded px-1.5 py-0.5 text-xs ${
                      row.type === 'ranking' ? 'bg-brand-50 text-brand' : 'bg-blush-50 text-blush-700'
                    }`}
                  >
                    {row.type === 'ranking' ? '排名词' : '口碑词'}
                  </span>
                  {/* 语义层由 LLM 判定:已分层彩色徽标;未分层灰色并提示将自动补齐 */}
                  {row.groupName ? (
                    <span className="rounded bg-teal-50 px-1.5 py-0.5 text-xs text-teal-700">{row.groupName}</span>
                  ) : (
                    <span
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400"
                      title="语义层待 AI 判定,稍后刷新自动补齐"
                    >
                      分层待定
                    </span>
                  )}
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
