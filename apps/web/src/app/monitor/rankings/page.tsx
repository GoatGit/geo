'use client';

import { useState } from 'react';
import { MetricCardView } from '@/components/metric-card';
import { EmptyState, PageHeader, Skeleton, pct } from '@/components/ui';
import { useRankings } from '@/lib/queries';
import { EvidenceModal } from '@/components/evidence-modal';

/** 排名透视(docs/01 §3.3,对标竞品全景矩阵重构):
 * 指标卡组 → 分引擎三率条 → 全景矩阵(综合名次+三率与引擎分组之间有分割线)。 */

const RATE_BARS: Array<{ key: 'mentionRate' | 'top3Rate' | 'top1Rate'; label: string; tone: string }> = [
  { key: 'mentionRate', label: '提及', tone: 'bg-brand-500' },
  { key: 'top3Rate', label: 'Top3', tone: 'bg-brand-700' },
  { key: 'top1Rate', label: '首推', tone: 'bg-good' },
];

export default function RankingsPage() {
  const [days, setDays] = useState(1);
  const [engineFilter, setEngineFilter] = useState<string>('all');
  const [questionFilter, setQuestionFilter] = useState<string>('all');
  const [evidenceRun, setEvidenceRun] = useState<number | null>(null);
  const { data, isLoading, error } = useRankings(days);

  if (isLoading) return <Skeleton />;
  if (error) {
    return <EmptyState title="数据加载失败" text={`${(error as Error).message} —— 请稍后重试,或在顶栏切换品牌。`} />;
  }
  if (!data) return <EmptyState text="暂无数据:完成品牌与问题配置后,首轮采集结果将在此展示" />;

  const visibleEngines = engineFilter === 'all' ? data.engineStats.map((e) => e.engine) : [engineFilter];
  const visibleRows = data.matrix.filter(
    (r) => questionFilter === 'all' || String(r.questionId) === questionFilter,
  );
  const exportMatrix = (rows: typeof data.matrix, engines: string[]) => {
    const header = ['监控问题', ...engines, '综合名次', '提及率', 'Top3 率', '首推率'];
    const lines = rows.map((r) => {
      const cells = engines.map((eng) => {
        const c = r.cells.find((x) => x.engine === eng);
        return c ? (c.rank !== null ? `#${c.rank}` : c.mentioned ? '提及未上榜' : '未上榜') : '—';
      });
      return [r.questionText, ...cells, r.compositeRank ?? '', pct(r.mentionRate), pct(r.top3Rate), pct(r.top1Rate)];
    });
    const csv = [header, ...lines].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `排名矩阵-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="排名透视"
        actions={
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
            {[[1, '今日'], [7, '近 7 天'], [30, '近 30 天']].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setDays(v as number)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  days === v ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCardView title="提及率" card={data.cards.find((c) => c.metric === 'mentionRate')} spark={data.trend.map((t) => t.mentionRate)} sparkLabel="提及率" />
        <MetricCardView title="Top3 率" card={data.cards.find((c) => c.metric === 'top3Rate')} spark={data.trend.map((t) => t.top3Rate)} sparkLabel="Top3 率" />
        <MetricCardView title="首推率" card={data.cards.find((c) => c.metric === 'top1Rate')} spark={data.trend.map((t) => t.top1Rate)} sparkLabel="首推率" />
        <MetricCardView title="平均名次" card={data.cards.find((c) => c.metric === 'avgRank')} lowerBetter />
      </section>

      {/* ===== 分引擎三率(条形对比,置于矩阵前) ===== */}
      <section className="card rise p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">分引擎三率</h2>
          <div className="flex items-center gap-3 text-[10px] text-slate-400">
            {RATE_BARS.map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1">
                <span className={`h-1.5 w-3 rounded-full ${b.tone}`} />
                {b.label}率
              </span>
            ))}
          </div>
        </div>
        <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
          {data.engineStats.map((e) => (
            <div key={e.engine} className="flex items-center gap-3">
              <span className="w-20 shrink-0 truncate text-xs font-semibold text-slate-700">{e.engine}</span>
              <div className="grid flex-1 gap-1">
                {RATE_BARS.map((b) => (
                  <div key={b.key} className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                      <div className={`h-1.5 rounded-full ${b.tone}`} style={{ width: `${Math.round(e[b.key] * 100)}%` }} />
                    </div>
                    <span className="metric-num w-10 text-right text-[11px] text-slate-500">{pct2(e[b.key])}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {data.engineStats.length === 0 && <p className="text-sm text-slate-400">暂无采集数据</p>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={engineFilter}
          onChange={(e) => setEngineFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm"
        >
          <option value="all">全部引擎</option>
          {data.engineStats.map((e) => (
            <option key={e.engine} value={e.engine}>{e.engine}</option>
          ))}
        </select>
        <select
          value={questionFilter}
          onChange={(e) => setQuestionFilter(e.target.value)}
          className="h-9 max-w-[320px] rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm"
        >
          <option value="all">全部问题</option>
          {data.matrix.map((r) => (
            <option key={r.questionId} value={String(r.questionId)}>
              {r.questionText.slice(0, 30)}
            </option>
          ))}
        </select>
        <button
          onClick={() => exportMatrix(data.matrix, data.engineStats.map((e) => e.engine))}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm hover:border-brand-300"
        >
          导出 CSV
        </button>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="metric-num rounded bg-good-50 px-1.5 py-0.5 text-good">#1</span>首推
          <span className="metric-num ml-1 rounded bg-brand-50 px-1.5 py-0.5 text-brand-700">#2-3</span>Top3
          <span className="metric-num ml-1 rounded bg-slate-100 px-1.5 py-0.5">#4+</span>靠后
          <span className="ml-1 rounded bg-bad-50 px-1.5 py-0.5 text-bad">未上榜</span>
          <span className="ml-1 text-slate-400">综合名次 = 未上榜记 N+1 取中位数</span>
        </span>
      </div>

      {/* ===== 全景矩阵 ===== */}
      <section className="table-wrap overflow-x-auto rounded-xl border border-slate-100">
        <table className="w-full border-collapse text-[12.5px]" style={{ borderSpacing: 0 }}>
          <thead>
            <tr className="bg-slate-50/90 text-[11.5px] font-semibold text-slate-500">
              <th className="sticky left-0 z-10 border-b border-slate-200 bg-slate-50/95 px-4 py-2.5 text-left backdrop-blur">监控问题</th>
              {visibleEngines.map((eng) => (
                <th key={eng} className="border-b border-slate-200 px-2.5 py-2.5 text-center">{eng}</th>
              ))}
              {/* 分组分割线:引擎组 | 综合+三率组 */}
              <th className="border-b border-l-2 border-l-slate-200 border-slate-200 px-3 py-2.5 text-center">综合名次</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">提及率</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">Top3 率</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">首推率</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.questionId} className="transition-colors hover:bg-brand-50/40">
                <td
                  className="sticky left-0 z-10 max-w-72 truncate border-t border-slate-100 bg-white px-4 py-2"
                  title={row.questionText}
                >
                  {row.questionText}
                </td>
                {visibleEngines.map((eng) => {
                  const cell = row.cells.find((c) => c.engine === eng);
                  return (
                    <td key={eng} className="border-t border-slate-100 px-2.5 py-2 text-center">
                      {!cell ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button
                          disabled={!cell.runId}
                          onClick={() => cell.runId && setEvidenceRun(cell.runId)}
                          title={cell.runId ? '点击查看该引擎的 AI 回答原文与存证' : '该单元格暂无可回溯的采集记录'}
                          className={`rounded transition-transform ${
                            cell.runId ? 'hover:-translate-y-px hover:shadow-sm' : 'cursor-default'
                          }`}
                        >
                          {cell.rank !== null ? (
                            <span
                              className={`metric-num inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                                cell.rank === 1
                                  ? 'bg-good-50 text-good'
                                  : cell.rank <= 3
                                    ? 'bg-brand-50 text-brand'
                                    : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              #{cell.rank}
                              {cell.prevRank != null && cell.rank !== cell.prevRank && (
                                <span className={cell.rank < cell.prevRank ? 'text-good' : 'text-bad'}>
                                  {cell.rank < cell.prevRank ? '▲' : '▼'}
                                </span>
                              )}
                            </span>
                          ) : cell.mentioned ? (
                            <span className="block px-1 py-0.5 text-xs text-slate-400">提及未上榜</span>
                          ) : (
                            <span className="block rounded bg-bad-50 px-1.5 py-0.5 text-xs text-bad">未上榜</span>
                          )}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="metric-num border-l-2 border-slate-200 border-t border-t-slate-100 px-3 py-2 text-center font-semibold">
                  {row.compositeRank != null ? `第${row.compositeRank}名` : '未上榜'}
                </td>
                <td className="metric-num border-t border-slate-100 px-3 py-2 text-center">{pct(row.mentionRate)}</td>
                <td className="metric-num border-t border-slate-100 px-3 py-2 text-center">{pct(row.top3Rate)}</td>
                <td className="metric-num border-t border-slate-100 px-3 py-2 text-center">{pct(row.top1Rate)}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={visibleEngines.length + 5} className="px-4 py-8 text-center text-slate-400">
                  暂无监控问题
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <EvidenceModal runId={evidenceRun} onClose={() => setEvidenceRun(null)} />
    </div>
  );
}

function pct2(v: number) {
  return `${Math.round(v * 100)}%`;
}
