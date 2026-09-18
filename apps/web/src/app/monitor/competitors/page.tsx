'use client';
import { engineLabel } from '@geo/shared';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton, pct } from '@/components/ui';

interface CompetitorsMatrixDto {
  rows: Array<{
    key: string;
    name: string;
    totalMentions: number;
    engines: Record<string, { mentionRate: number | null; top3Rate: number | null }>;
  }>;
  engines: string[];
}

interface LeaderRow {
  key: string;
  name: string;
  mentions: number;
  mentionRate: number | null;
  top3Rate: number | null;
  top1Rate: number | null;
}

/** 竞品透视(docs/01 §3.4):竞品榜单 + 竞品×引擎 分引擎对比热力矩阵(同批查询同口径)。 */
export default function CompetitorsPage() {
  const brandId = useBrandId();
  const queryClient = useQueryClient();
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const days = 7;
  const leader = useQuery({
    queryKey: ['competitors', brandId],
    queryFn: () => api<LeaderRow[]>(`/monitor/competitors?brand=${brandId}&days=${days}`),
    enabled: !!brandId,
  });
  const matrix = useQuery({
    queryKey: ['competitors-matrix', brandId],
    queryFn: () =>
      api<CompetitorsMatrixDto>(`/monitor/competitors/matrix?brand=${brandId}&days=${days}`),
    enabled: !!brandId,
  });

  if (leader.isLoading || matrix.isLoading) return <Skeleton />;
  const rows = matrix.data?.rows ?? [];
  const engines = matrix.data?.engines ?? [];
  const board = leader.data ?? [];

  const heat = (v: number | null): string => {
    if (v == null) return 'transparent';
    const alpha = 0.08 + v * 0.72;
    return `rgba(111,124,109,${alpha.toFixed(2)})`;
  };
  const heatText = (v: number | null): string => (v != null && v > 0.55 ? '#f4f6f3' : 'inherit');

  const doMerge = async (fromKey: string) => {
    if (!mergeFrom || mergeFrom === fromKey) return;
    setMergeBusy(true);
    try {
      await api('/monitor/competitors/merge', {
        method: 'POST',
        json: { brand: brandId, fromKey, toKey: mergeFrom },
      });
      setMergeFrom(null);
      void queryClient.invalidateQueries({ queryKey: ['competitors', brandId] });
      void queryClient.invalidateQueries({ queryKey: ['competitors-matrix', brandId] });
    } finally {
      setMergeBusy(false);
    }
  };

  const top = leader.data?.[0];
  return (
    <div className="space-y-6">
      <PageHeader
        title="竞品透视"
        desc="基于同批 AI 查询的竞品提及与位次分析;「修正品牌名」可把变体写法归并,消除重复计数"
      />
      {top && (
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="card p-5">
            <p className="text-xs text-slate-400">竞品总数</p>
            <p className="metric-num mt-1 text-2xl font-extrabold text-slate-900">{board.length}</p>
          </div>
          <div className="card p-5">
            <p className="text-xs text-slate-400">最强竞品</p>
            <p className="mt-1 truncate text-sm font-bold text-slate-900">{top.name}</p>
          </div>
          <div className="card p-5">
            <p className="text-xs text-slate-400">最强竞品提及率</p>
            <p className="metric-num mt-1 text-2xl font-extrabold text-slate-900">{pct(top.mentionRate)}</p>
          </div>
          <div className="card p-5">
            <p className="text-xs text-slate-400">最强竞品 Top3 率</p>
            <p className="metric-num mt-1 text-2xl font-extrabold text-slate-900">{pct(top.top3Rate)}</p>
          </div>
        </section>
      )}

      {board.length === 0 && rows.length === 0 ? (
        <EmptyState
          title="暂无竞品数据"
          text="竞品来自与本品同批查询的 AI 回答(同口径解析)。完成首轮采集后,高频出现的品牌会自动进入榜单;"
          action={null}
        />
      ) : (
        <>
          {/* 竞品榜单 */}
          <section className="table-wrap rise">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3">竞品</th>
                  <th className="px-3 py-3">出现次数</th>
                  <th className="px-3 py-3">提及率</th>
                  <th className="px-3 py-3">Top3 率</th>
                  <th className="px-3 py-3">首推率</th>
                </tr>
              </thead>
              <tbody>
                {board.map((r, i) => (
                  <tr key={r.key} className="table-row">
                    <td className="px-4 py-2.5 font-medium text-slate-800">
                      <span className="metric-num mr-2 text-xs text-slate-400">#{i + 1}</span>
                      {r.name}
                      {mergeFrom === r.key && (
                        <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-700">
                          归并目标——请点其他行的「并入」
                        </span>
                      )}
                    </td>
                    <td className="metric-num px-3 py-2.5">{r.mentions}</td>
                    <td className="metric-num px-3 py-2.5">{pct(r.mentionRate)}</td>
                    <td className="metric-num px-3 py-2.5">{pct(r.top3Rate)}</td>
                    <td className="metric-num px-3 py-2.5">{pct(r.top1Rate)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {mergeFrom === r.key ? (
                        <span className="text-[11px] text-slate-400">源条目</span>
                      ) : (
                        <button
                          onClick={() => doMerge(r.key)}
                          disabled={mergeBusy}
                          title={mergeFrom ? `把「${r.name}」并入「${board.find(b => b.key === mergeFrom)?.name ?? ''}」` : '先点目标行的「修正品牌名」'}
                          className={`text-[11px] transition-colors ${
                            mergeFrom ? 'text-brand-600 hover:underline' : 'text-slate-300'
                          }`}
                        >
                          并入
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {board.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* 竞品×引擎 对比矩阵(热力) */}
          <section className="card rise-1 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">分引擎对比矩阵</h2>
              <span className="text-[11px] text-slate-400">单元格 = 竞品在该引擎的提及率;颜色越深越高</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-2 pr-4 font-medium">竞品</th>
                    {engines.map((e) => (
                      <th key={e} className="px-3 py-2 font-medium">
                        {engineLabel(e)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-slate-100">
                      <td className="max-w-44 truncate py-2.5 pr-4 font-medium text-slate-800" title={r.name}>
                        {r.name}
                      </td>
                      {engines.map((e) => {
                        const cell = r.engines[e];
                        const v = cell?.mentionRate ?? null;
                        return (
                          <td key={e} className="px-2 py-2">
                            <div
                              className="metric-num rounded-lg px-2.5 py-1.5 text-center text-xs transition-transform hover:scale-105"
                              style={{ background: heat(v), color: heatText(v) }}
                              title={cell?.top3Rate != null ? `Top3 率 ${pct(cell.top3Rate)}` : undefined}
                            >
                              {v == null ? '—' : `${Math.round(v * 100)}%`}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={engines.length + 1} className="py-8 text-center text-slate-400">
                        暂无数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-slate-400">
              竞品与本品同批查询、同口径解析;高频未匹配实体经确认后进入竞品口径(docs/01 §3.4)。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
