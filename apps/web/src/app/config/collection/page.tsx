'use client';

import { useQuery } from '@tanstack/react-query';
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
  const { data, isLoading } = useQuery({
    queryKey: ['collection', brandId],
    queryFn: () => api<StatusDto>(`/collection/status?brand=${brandId}`),
    enabled: !!brandId,
    refetchInterval: 10_000,
  });

  if (isLoading) return <Skeleton />;
  if (!data) return <EmptyState text="暂无采集计划" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="采集状态"
        desc={
          data.plan
            ? `计划:每日 ${data.plan.freq} 轮 · 引擎 ${data.plan.engines.join(' / ')}${
                data.plan.nextRunAt ? ` · 下轮 ${new Date(data.plan.nextRunAt).toLocaleString('zh-CN')}` : ' · 待问题配置后触发首轮'
              }`
            : '无采集计划'
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
                      <span className="rounded bg-red-50 px-1.5 py-0.5 text-bad">熔断维护中,数据将延迟</span>
                    ) : (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-good">正常</span>
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
              return (
                <li key={r.id} className="flex items-center justify-between">
                  <span>轮次 #{r.id}</span>
                  <span className="metric-num text-xs text-slate-500">
                    {done}/{total} {r.finishedAt ? '· 已完成' : '· 进行中'}
                  </span>
                  <div className="h-1.5 w-32 rounded bg-slate-100">
                    <div className="h-1.5 rounded bg-brand" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
                  </div>
                </li>
              );
            })}
            {data.rounds.length === 0 && <li className="text-slate-400">还没有轮次</li>}
          </ul>
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
                  ? 'bg-emerald-400'
                  : r.status === 'ok_empty'
                    ? 'bg-slate-300'
                    : r.status === 'failed'
                      ? 'bg-red-400'
                      : 'bg-amber-300'
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
