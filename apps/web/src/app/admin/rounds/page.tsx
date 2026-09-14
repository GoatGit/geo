'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader, Skeleton } from '@/components/ui';

interface RoundRow {
  id: number;
  brandId: number;
  brandName: string;
  startedAt: string;
  finishedAt: string | null;
  totals: { total?: number; enqueued?: number; done?: number; ok?: number; failed?: number } | null;
}

/** 平台后台 · 采集轮次:跨品牌轮次进度与结果分布(自动刷新)。 */
export default function AdminRoundsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-rounds'],
    queryFn: () => api<{ rounds: RoundRow[] }>('/admin/rounds?limit=100'),
    refetchInterval: 10_000,
  });

  if (isLoading || !data) return <Skeleton />;

  return (
    <>
      <PageHeader title="采集轮次" desc="全品牌最近 100 个轮次,每 10 秒自动刷新" />

      <section className="card rise p-6">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-400">
            <tr>
              <th className="py-1.5">轮次</th>
              <th className="py-1.5">品牌</th>
              <th className="py-1.5">开始时间</th>
              <th className="py-1.5">进度</th>
              <th className="py-1.5">结果</th>
              <th className="py-1.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {data.rounds.map((r) => {
              const t = r.totals ?? {};
              const total = t.total ?? 0;
              const done = t.done ?? 0;
              const failed = t.failed ?? 0;
              return (
                <tr key={r.id} className="border-t">
                  <td className="metric-num py-2">#{r.id}</td>
                  <td className="py-2">{r.brandName}</td>
                  <td className="py-2 text-slate-500">{new Date(r.startedAt).toLocaleString('zh-CN')}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="metric-num w-14 text-slate-500">
                        {done}/{total}
                      </span>
                      <div className="h-1.5 w-28 rounded bg-slate-100">
                        <div className="h-1.5 rounded bg-brand" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
                      </div>
                    </div>
                  </td>
                  <td className="metric-num py-2 text-slate-500">
                    {Math.max(done - failed, 0)}✓ / {failed}✗
                  </td>
                  <td className="py-2">
                    {r.finishedAt ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-good">已完成</span>
                    ) : (
                      <span className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-700">进行中</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {data.rounds.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400">
                  还没有轮次
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
