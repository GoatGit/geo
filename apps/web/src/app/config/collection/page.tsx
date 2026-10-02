'use client';
import { engineLabel } from '@geo/shared';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

interface StatusDto {
  plan: { engines: string[]; surfaces: string[]; freq: number; nextRunAt: string | null; active: boolean } | null;
  engines: Array<{ engine: string; paused: boolean; recent: number; ok: number; failed: number; successRate: number | null }>;
  rounds: Array<{
    id: number;
    startedAt: string;
    finishedAt: string | null;
    totals: { total?: number; done?: number; ok?: number; failed?: number; quota_blocked?: number } | null;
    failReasons?: Array<{ engine: string; reason: string; count: number }>;
  }>;
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
  // 轮次失败明细:点击 ✗ 展开/收起(悬停 title 仅作辅助)
  const [expandedRound, setExpandedRound] = useState<number | null>(null);
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
  if (!data)
    return (
      <EmptyState
        title="采集尚未开始"
        text="添加监控问题后,系统会按套餐频率自动采集各引擎数据;此处展示每次采集的进度与健康度。"
        action={
          <a href="/config/questions" className="btn-primary">
            去添加监控问题
          </a>
        }
      />
    );

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
                  <td className="py-1.5">{engineLabel(e.engine)}</td>
                  <td className="metric-num py-1.5">
                    {e.ok}✓ / {e.failed}✗
                  </td>
                  <td className="metric-num py-1.5">{e.successRate == null ? '—' : `${Math.round(e.successRate * 100)}%`}</td>
                  <td className="py-1.5">
                    {e.paused ? (
                      <span className="rounded bg-bad-50 px-1.5 py-0.5 text-bad" title="该引擎连续失败已触发自动保护,暂停采集;恢复后自动续上">引擎维护中,数据将延迟</span>
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
              const total = t.total ?? 0;
              // done 含被拦截项,不能当成功展示:细分 ok(有效)/failed/quota_blocked(拦截)
              const failed = t.failed ?? 0;
              const blocked = t.quota_blocked ?? 0;
              const ok = t.ok ?? Math.max((t.done ?? 0) - failed - blocked, 0);
              const pctOf = (n: number) => (total ? `${(n / total) * 100}%` : 0);
              // 悬停 ✗ 的失败原因提示:按引擎+原因聚合,次数降序
              const failTip = (r.failReasons ?? [])
                .map((f) => `${f.engine}:${f.reason} ×${f.count}`)
                .join('\n') || `本轮 ${failed} 个失败,暂无原因明细`;
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>轮次 #{r.id}</span>
                  <span className="metric-num text-xs">
                    <span className={ok > 0 ? 'text-good' : 'text-slate-300'}>{ok}✓</span>
                    {failed > 0 && (
                      <span
                        className="cursor-pointer border-b border-dotted border-bad/60"
                        title={failTip}
                        onClick={() => setExpandedRound(expandedRound === r.id ? null : r.id)}
                      >
                        {' · '}
                        {failed}✗
                      </span>
                    )}
                    {blocked > 0 && (
                      <span
                        className="cursor-help border-b border-dotted border-warn/60"
                        title={`被拦截 = 执行前检查发现该引擎无可用采集容量(账号全部冷却/当日配额用完/无已登录账号),任务未发起、不消耗失败,后续轮次自动补跑`}
                      >
                        {' · '}
                        {blocked} 被拦截
                      </span>
                    )}
                    <span className="text-slate-400"> / {total}</span>
                    {r.finishedAt ? ' · 已完成' : ' · 进行中'}
                  </span>
                  <div className="flex h-1.5 w-32 overflow-hidden rounded bg-slate-100">
                    <div className="h-1.5 bg-good" style={{ width: pctOf(ok) }} />
                    <div className="h-1.5 bg-bad" style={{ width: pctOf(failed) }} />
                    <div className="h-1.5 bg-warn" style={{ width: pctOf(blocked) }} />
                  </div>
                  {expandedRound === r.id && (r.failReasons?.length ?? 0) > 0 && (
                    <div className="w-full rounded border border-slate-200 bg-slate-50 p-2 text-xs leading-5 text-slate-600">
                      {(r.failReasons ?? []).map((f, i) => (
                        <div key={i} className="truncate" title={f.reason}>
                          <span className="mr-1 font-medium text-slate-700">{f.engine}</span>×{f.count} · {f.reason}
                        </div>
                      ))}
                    </div>
                  )}
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
            {data.rounds.length === 0 && (
              <li className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                还没有轮次——点右上角「立即采集」马上开始第一轮
              </li>
            )}
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
          绿=有回答 · 灰=空回答 · 红=失败 · 黄=配额拦截;失败和被拦截的查询不会算进成功率/提及率等指标,但会一直展示在这里。
        </p>
      </section>
    </div>
  );
}
