'use client';
import { engineLabel, sanitizeCitationTitle } from '@geo/shared';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton, pct } from '@/components/ui';

const PAGE_SIZE = 20;

interface CitationsDto {
  items: Array<{ url: string; domain: string; title: string | null; isOwned: boolean; engine: string; extractedAt: string }>;
  preference: Array<{ platform?: string; domain: string; domains?: string[]; category: string; hits: number; owned: number }>;
  perEngine: Array<{
    engine: string;
    total: number;
    authoritativeShare: number | null;
    categories: Array<{ category: string; hits: number }>;
    topDomains: Array<{ domain: string; platform: string; hits: number }>;
  }>;
  totals: { citations: number; owned: number; ownedShare: number | null; authoritative: number; authoritativeShare: number | null };
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
    return (
      <EmptyState
        title="数据加载失败"
        text={`${(error as Error).message} —— 请重试,或在顶栏切换品牌。`}
        action={
          <button className="btn-primary" onClick={() => void refetch()}>
            重试
          </button>
        }
      />
    );
  }
  if (!data) return <EmptyState text="暂无引用数据" />;

  return (
    <div className="space-y-6">
      <PageHeader title="引用源分析" desc="统计范围:近 7 天" />

      <section className="card rise-1 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">信源平台偏好(TOP 20)</h2>
          {data.totals.citations > 0 && (
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span>
                权威信源引用率
                <b className="metric-num ml-1.5 text-sm text-slate-800">
                  {data.totals.authoritativeShare == null ? '—' : pct(data.totals.authoritativeShare)}
                </b>
              </span>
              <span>
                自有信源
                <b className="metric-num ml-1.5 text-sm text-slate-800">
                  {data.totals.ownedShare == null ? '—' : pct(data.totals.ownedShare)}
                </b>
              </span>
              <span>
                共 <b className="metric-num text-sm text-slate-800">{data.totals.citations}</b> 条
              </span>
            </div>
          )}
        </div>
        <p className="mb-3 text-xs text-slate-400">权威信源 = 门户/官媒、权威机构、官网;AI 引用权威信源占比越高,品牌信息的可信背书越足。</p>
        <div className="space-y-1.5">
          {data.preference.map((p) => (
            <div key={p.platform ?? p.domain} className="flex items-center gap-2 text-xs">
              <span className="w-48 truncate font-medium text-slate-700" title={(p.domains ?? [p.domain]).join('、')}>
                {p.platform ?? p.domain}
              </span>
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

      {/* 分引擎信源偏好:各引擎引用的信源类别构成与高频域名(实测数据聚合,非经验库) */}
      {data.perEngine.length > 0 && (
        <section className="card rise-2 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">分引擎信源偏好</h2>
            <span className="text-xs text-slate-400">各引擎抓取信源的习惯不同 —— 按引擎偏好布局内容,才能被优先采信</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.perEngine.map((e) => (
              <div key={e.engine} className="rounded-xl border border-slate-100 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800">{engineLabel(e.engine)}</span>
                  <span className="text-xs text-slate-400">
                    {e.total} 条 · 权威 {e.authoritativeShare == null ? '—' : pct(e.authoritativeShare)}
                  </span>
                </div>
                <div className="space-y-1">
                  {e.categories.map((c) => (
                    <div key={c.category} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 truncate text-slate-600" title={c.category}>{c.category}</span>
                      <div className="h-1.5 flex-1 rounded bg-slate-100">
                        <div className="h-1.5 rounded bg-brand" style={{ width: `${Math.min(100, (c.hits / (e.categories[0]!.hits || 1)) * 100)}%` }} />
                      </div>
                      <span className="metric-num w-8 text-right text-slate-500">{c.hits}</span>
                    </div>
                  ))}
                </div>
                {e.topDomains.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-50 pt-3">
                    {e.topDomains.map((d) => (
                      <span key={d.domain} className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500" title={d.domain}>
                        {d.platform} ×{d.hits}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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
            {data.items.map((c, i) => {
              const title = sanitizeCitationTitle(c.title);
              return (
                <tr key={i} className="border-t">
                  <td className="max-w-80 truncate px-4 py-2">
                    <a
                      href={/^https?:\/\//.test(c.url) ? c.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={title ?? c.url}
                      className={title ? 'text-brand hover:underline' : 'text-slate-400 hover:underline'}
                    >
                      {title ?? '未取到标题'}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.domain}</td>
                  <td className="px-3 py-2 text-xs">{engineLabel(c.engine)}</td>
                  <td className="px-3 py-2 text-xs">{c.isOwned ? '✓' : ''}</td>
                </tr>
              );
            })}
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
