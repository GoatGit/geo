'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

interface StatusDto {
  plan: { engines: string[]; surfaces: string[]; freq: number; nextRunAt: string | null; active: boolean } | null;
  engines: Array<{ engine: string; paused: boolean; recent: number; ok: number; failed: number; successRate: number | null }>;
  rounds: Array<{ id: number; startedAt: string; finishedAt: string | null; totals: { total?: number; done?: number; ok?: number; failed?: number } | null }>;
  lastRuns: Array<{ status: string; engine: string; ranAt: string }>;
}

/** 采集状态页(docs/01 IA ④,"透明可信"的可见性锚点):引擎覆盖/健康度/熔断/轮次。 */
export default function CollectionPage() {
  const brandId = useBrandId();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['collection', brandId],
    queryFn: () => api<StatusDto>(`/collection/status?brand=${brandId}`),
    enabled: !!brandId,
    refetchInterval: 10_000,
  });

  const [triggering, setTriggering] = useState(false);
  const triggerNow = async () => {
    setMsg(null);
    setTriggering(true);
    try {
      await api('/collection/trigger', { method: 'POST', json: { brand: brandId } });
      setMsg('已触发立即采集,调度器将在 1 分钟内开始');
      void queryClient.invalidateQueries({ queryKey: ['collection', brandId] });
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  const retryFailed = async (roundId: number) => {
    setMsg(null);
    setRetrying(roundId);
    try {
      const r = await api<{ retried: number; roundId?: number; note?: string }>('/collection/retry-failed', {
        method: 'POST',
        json: { brand: brandId, roundId },
      });
      setMsg(r.retried > 0 ? `已提交重试:${r.retried} 项,新轮次 #${r.roundId}` : r.note ?? '没有失败项');
      void queryClient.invalidateQueries({ queryKey: ['collection', brandId] });
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setRetrying(null);
    }
  };

  if (isLoading) return <Skeleton />;
  if (!data) return <EmptyState text="暂无采集计划" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="采集状态"
        actions={
          <button onClick={triggerNow} disabled={triggering} className="btn-primary h-9 px-4 text-xs disabled:opacity-40">
            {triggering ? '触发中…' : '立即采集'}
          </button>
        }
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card rise-1 p-6">
          <h2 className="mb-4 font-semibold text-slate-900">引擎通道健康度</h2>
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="py-1">引擎</th>
                <th className="py-1">近 500 次</th>
                <th className="py-1">成功率</th>
                <th className="py-1">状态</th>
              </tr>
            </thead>
            <tbody>
              {data.engines.map((e) => (
                <tr key={e.engine} className="border-t">
                  <td className="py-1.5">{e.engine}</td>
                  <td className="metric-num py-1.5">
                    {e.ok}✓ / {e.failed}✗
                  </td>
                  <td className="metric-num py-1.5">{e.successRate == null ? '—' : `${Math.round(e.successRate * 100)}%`}</td>
                  <td className="py-1.5">
                    {e.paused ? (
                      <span className="rounded bg-bad-50 px-1.5 py-0.5 text-bad">熔断维护中,数据将延迟</span>
                    ) : (
                      <span className="rounded bg-good-50 px-1.5 py-0.5 text-good">正常</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card p-6">
          <h2 className="mb-4 font-semibold text-slate-900">最近轮次</h2>
          <ul className="space-y-2 text-sm">
            {data.rounds.map((r) => {
              const t = r.totals ?? {};
              const done = t.done ?? 0;
              const total = t.total ?? 0;
              const failed = t.failed ?? 0;
              return (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span>轮次 #{r.id}</span>
                  <span className="metric-num text-xs text-slate-500">
                    {done}/{total}
                    {failed > 0 && <span className="text-bad"> · 失败 {failed}</span>}
                    {r.finishedAt ? ' · 已完成' : ' · 进行中'}
                  </span>
                  <div className="h-1.5 w-32 rounded bg-slate-100">
                    <div className="h-1.5 rounded bg-brand" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
                  </div>
                  {r.finishedAt && failed > 0 && (
                    <button
                      onClick={() => retryFailed(r.id)}
                      disabled={retrying !== null}
                      className="btn-soft h-7 shrink-0 px-2.5 text-[11px] disabled:opacity-40"
                    >
                      {retrying === r.id ? '提交中…' : '重试失败项'}
                    </button>
                  )}
                </li>
              );
            })}
            {data.rounds.length === 0 && <li className="text-slate-400">还没有轮次</li>}
          </ul>
          {msg && <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">{msg}</p>}
        </div>
      </section>

      <section className="card rise-2 p-6">
        <h2 className="mb-3 font-semibold text-slate-900">最近任务</h2>
        <div className="flex flex-wrap gap-1.5">
          {data.lastRuns.slice(0, 60).map((r, i) => (
            <span
              key={i}
              title={`${r.engine} · ${r.status} · ${new Date(r.ranAt).toLocaleTimeString('zh-CN')}`}
              className={`h-2.5 w-2.5 rounded-sm ${
                r.status === 'ok_with_answer'
                  ? 'bg-good'
                  : r.status === 'ok_empty'
                    ? 'bg-slate-300'
                    : r.status === 'failed'
                      ? 'bg-bad'
                      : 'bg-warn'
              }`}
            />
          ))}
          {data.lastRuns.length === 0 && <span className="text-sm text-slate-400">暂无任务</span>}
        </div>
        <p className="mt-2 text-[10px] text-slate-400">
          绿=有回答 · 灰=空回答 · 红=失败 · 黄=配额拦截;失败/拦截不计入指标分母,但永远可见(docs/02 §1.1)。
        </p>
      </section>
    </div>
  );
}
