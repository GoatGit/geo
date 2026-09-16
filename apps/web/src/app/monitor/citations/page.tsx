'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

const PAGE_SIZE = 20;

interface CitationsDto {
  items: Array<{ url: string; domain: string; title: string | null; isOwned: boolean; engine: string; extractedAt: string }>;
  preference: Array<{ domain: string; category: string; hits: number; owned: number }>;
  totals: { citations: number; owned: number; ownedShare: number | null };
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export default function CitationsPage() {
  const brandId = useBrandId();
  const [page, setPage] = useState(1);
  // 切换品牌后回到第 1 页(分页参数不跨品牌残留)
  useEffect(() => setPage(1), [brandId]);
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['citations', brandId, page],
    queryFn: () => api<CitationsDto>(`/monitor/citations?brand=${brandId}&days=7&page=${page}&pageSize=${PAGE_SIZE}`),
    enabled: !!brandId,
    placeholderData: (prev) => prev,
  });

  if (isLoading) return <Skeleton />;
  if (error) {
    return <EmptyState title="数据加载失败" text={`${(error as Error).message} —— 请稍后重试,或在顶栏切换品牌。`} />;
  }
  if (!data) return <EmptyState text="暂无引用数据" />;

  return (
    <div className="space-y-6">
      <PageHeader title="引用源分析" />

      <section className="card rise-1 p-6">
        <h2 className="mb-4 font-semibold text-slate-900">信源平台偏好(TOP 20)</h2>
        <div className="space-y-1.5">
          {data.preference.map((p) => (
            <div key={p.domain} className="flex items-center gap-2 text-xs">
              <span className="w-48 truncate">{p.domain}</span>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div
                  className="h-2 rounded bg-brand"
                  style={{ width: `${Math.min(100, (p.hits / (data.preference[0]?.hits || 1)) * 100)}%` }}
                />
              </div>
              <span className="metric-num w-10 text-right text-slate-500">{p.hits}</span>
            </div>
          ))}
          {data.preference.length === 0 && <p className="text-sm text-slate-400">暂无数据</p>}
        </div>
      </section>

      <section className="table-wrap rise-2">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="px-4 py-2.5">标题</th>
              <th className="px-3 py-2.5">域名</th>
              <th className="px-3 py-2.5">引擎</th>
              <th className="px-3 py-2.5">自有</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((c, i) => (
              <tr key={i} className="border-t">
                <td className="max-w-80 truncate px-4 py-2">
                  <a href={/^https?:\/\//.test(c.url) ? c.url : undefined} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                    {c.title ?? c.url}
                  </a>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.domain}</td>
                <td className="px-3 py-2 text-xs">{c.engine}</td>
                <td className="px-3 py-2 text-xs">{c.isOwned ? '✓' : ''}</td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  引用提取为小时级异步管道,首轮完成后稍候刷新(管道进度见采集状态页)
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* 分页(服务端分页;切换时保留旧数据避免跳动) */}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-slate-500">
          <span className="metric-num">
            共 {data.total} 条 · 第 {data.page}/{data.totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((v) => Math.max(1, v - 1))}
              disabled={data.page <= 1 || isFetching}
              className="btn-soft h-8 px-3 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              onClick={() => setPage((v) => Math.min(data.totalPages, v + 1))}
              disabled={data.page >= data.totalPages || isFetching}
              className="btn-soft h-8 px-3 disabled:opacity-40"
            >
              下一页
            </button>
            <button onClick={() => refetch()} disabled={isFetching} className="h-8 px-2 text-slate-400 hover:text-slate-600 disabled:opacity-40">
              刷新
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
