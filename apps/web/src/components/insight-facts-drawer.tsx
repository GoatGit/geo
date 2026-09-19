'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ENGINE_LABELS, type InsightDrill } from '@geo/shared';
import { api } from '@/lib/api';

/**
 * 1.5 数字下钻(rubric docs/10):报告数字 → 事实明细抽屉。
 * 排行条目/热力格子/桑基标签点击后打开,分页拉取 mention 命中(含回答摘录)
 * 或 citation 引用记录;数据窗口与报告一致,由 API 侧保证。
 */

interface FactsDto {
  kind: 'mentions' | 'citations';
  total: number;
  page: number;
  pageSize: number;
  rows: Array<Record<string, unknown>>;
}

const drillTitle = (d: InsightDrill): string =>
  d.kind === 'citations'
    ? `引用明细${d.bucket ? ` · ${d.bucket}` : d.domain ? ` · ${d.domain}` : ''}`
    : `命中明细${d.subject ? ` · ${d.subject}` : ''}${d.layer ? ` · ${d.layer}` : ''}${d.engine ? ` · ${ENGINE_LABELS[d.engine] ?? d.engine}` : ''}`;

export function InsightFactsDrawer({
  insightId,
  drill,
  onClose,
}: {
  insightId: number;
  drill: InsightDrill;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  // Escape 关闭(遮罩点击之外的标准退出方式)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const query = useQuery({
    queryKey: ['insight-facts', insightId, drill, page],
    queryFn: () => {
      const qs = new URLSearchParams({ kind: drill.kind, page: String(page), pageSize: '20' });
      if (drill.subject) qs.set('subject', drill.subject);
      if (drill.layer) qs.set('layer', drill.layer);
      if (drill.engine) qs.set('engine', drill.engine);
      if (drill.domain) qs.set('domain', drill.domain);
      if (drill.bucket) qs.set('bucket', drill.bucket);
      return api<FactsDto>(`/insights/${insightId}/facts?${qs.toString()}`, {
        auth: typeof window !== 'undefined' && !!localStorage.getItem('geo.accessToken') ? undefined : false,
      });
    },
  });

  const d = query.data;
  const totalPages = d ? Math.ceil(d.total / d.pageSize) : 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/50" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
          <div>
            <h3 className="text-[15px] font-bold text-slate-900">{drillTitle(drill)}</h3>
            <p className="mt-1 text-[11px] text-slate-400">
              {query.isLoading ? '加载中…' : `共 ${d?.total ?? 0} 条记录 · 窗口与报告一致`}
            </p>
          </div>
          <button className="btn-ghost h-8 px-3 text-xs" onClick={onClose}>关闭</button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {query.error && <p className="text-sm text-bad">加载失败:{(query.error as Error).message}</p>}
          {query.isLoading &&
            Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-100" />)}
          {d?.rows.length === 0 && !query.isLoading && (
            <p className="text-sm text-slate-400">该条件下没有命中记录。</p>
          )}
          {d?.kind === 'mentions' &&
            d.rows.map((r, i) => (
              <div key={i} className="rounded-lg border border-slate-100 p-3.5">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="metric-num">{fmtDate(r.ran_at as string)}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    {ENGINE_LABELS[String(r.engine ?? '')] ?? String(r.engine ?? '')}
                  </span>
                  {r.rank != null && <span className="metric-num text-slate-500">第 {String(r.rank)} 位</span>}
                  {r.layer != null && <span className="text-brand-700">{r.layer as string}</span>}
                </p>
                <p className="mt-1.5 text-[13px] font-medium leading-5 text-slate-800">{r.question as string}</p>
                {r.snippet ? (
                  <blockquote className="mt-2 border-l-2 border-brand-200 pl-2.5 text-[12.5px] leading-5 text-slate-500">
                    {String(r.snippet).length > 160 ? `${String(r.snippet).slice(0, 160)}…` : String(r.snippet)}
                  </blockquote>
                ) : (
                  <p className="mt-2 text-[12px] text-slate-300">(无摘录)</p>
                )}
              </div>
            ))}
          {d?.kind === 'citations' &&
            d.rows.map((r, i) => (
              <a
                key={i}
                href={r.raw_url as string}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-slate-100 p-3.5 transition-colors hover:border-brand-200"
              >
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="metric-num">{fmtDate(r.extracted_at as string)}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    {ENGINE_LABELS[String(r.engine ?? '')] ?? String(r.engine ?? '')}
                  </span>
                  <span className="metric-num text-slate-500">{r.domain as string}</span>
                  {r.is_owned ? <span className="text-good">品牌官网</span> : null}
                </p>
                <p className="mt-1.5 text-[13px] font-medium leading-5 text-slate-800">
                  {String(r.title ?? '') || String(r.raw_url ?? '')}
                </p>
                {r.question ? <p className="mt-1 text-[12px] text-slate-400">提问:{r.question as string}</p> : null}
              </a>
            ))}
        </div>

        {totalPages > 1 && (
          <footer className="flex items-center justify-between border-t border-slate-100 p-4">
            <span className="metric-num text-[11px] text-slate-400">
              第 {d?.page} / {totalPages} 页 · 共 {d?.total} 条
            </span>
            <span className="flex gap-2">
              <button className="btn-ghost h-8 px-3 text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <button
                className="btn-primary h-8 px-3 text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </span>
          </footer>
        )}
      </aside>
    </div>
  );
}

const fmtDate = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
