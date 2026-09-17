'use client';

import { useState } from 'react';
import { MetricCardView } from '@/components/metric-card';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { useRankings } from '@/lib/queries';
import { EvidenceModal } from '@/components/evidence-modal';

const LAYER_LABEL: Record<string, string> = {
  L1: 'L1 全线领先',
  L2: 'L2 多数上榜',
  L3: 'L3 少数上榜',
  L4: 'L4 全线缺席',
};

/** 排名透视(docs/01 §3.3):指标卡组 → 矩阵 → 漏斗 → 引擎分化。 */
export default function RankingsPage() {
  const [days, setDays] = useState(1);
  const [evidenceRun, setEvidenceRun] = useState<number | null>(null);
  const { data, isLoading, error } = useRankings(days);

  if (isLoading) return <Skeleton />;
  if (error) {
    return <EmptyState title="数据加载失败" text={`${(error as Error).message} —— 请稍后重试,或在顶栏切换品牌。`} />;
  }
  if (!data) return <EmptyState text="暂无数据:完成品牌与问题配置后,首轮采集结果将在此展示" />;

  return (
    <div className="space-y-6">
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

      <div className="rise flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
        <span className="font-medium text-slate-600">图例</span>
        <span className="inline-flex items-center gap-1.5"><span className="metric-num rounded bg-good-50 px-1.5 py-0.5 text-good">#1</span>首推</span>
        <span className="inline-flex items-center gap-1.5"><span className="metric-num rounded bg-brand-50 px-1.5 py-0.5 text-brand-700">#2-3</span>进 Top3</span>
        <span className="inline-flex items-center gap-1.5"><span className="metric-num rounded bg-slate-100 px-1.5 py-0.5">#4+</span>上榜靠后</span>
        <span className="inline-flex items-center gap-1.5"><span className="rounded bg-bad-50 px-1.5 py-0.5 text-bad">未上榜</span>出局</span>
        <span className="text-slate-400">综合名次 = 未上榜记 N+1 取中位数(docs/02 §1.3)</span>
      </div>

      <section className="table-wrap rise-1">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="px-4 py-3">监控问题</th>
              {data.engineStats.length > 0 &&
                data.engineStats.map((e) => (
                  <th key={e.engine} className="px-3 py-2.5">
                    {e.engine}
                  </th>
                ))}
              <th className="px-3 py-2.5">综合名次</th>
              <th className="px-3 py-2.5">分层</th>
            </tr>
          </thead>
          <tbody>
            {data.matrix.map((row) => (
              <tr key={row.questionId} className="border-t">
                <td className="max-w-72 truncate px-4 py-2.5" title={row.questionText}>
                  {row.questionText}
                </td>
                {data.engineStats.map((e) => {
                  const cell = row.cells.find((c) => c.engine === e.engine);
                  return (
                    <td key={e.engine} className="px-3 py-2.5">
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
                              className={`metric-num block rounded px-1.5 py-0.5 text-xs ${
                                cell.rank === 1
                                  ? 'bg-good-50 text-good'
                                  : cell.rank <= 3
                                    ? 'bg-brand-50 text-brand'
                                    : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              #{cell.rank}
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
                <td className="metric-num px-3 py-2.5">{row.compositeRank ?? '—'}</td>
                <td className="px-3 py-2.5 text-xs text-slate-500">{row.layer ? LAYER_LABEL[row.layer] : '样本不足'}</td>
              </tr>
            ))}
            {data.matrix.length === 0 && (
              <tr>
                <td colSpan={data.engineStats.length + 3} className="px-4 py-8 text-center text-slate-400">
                  暂无监控问题
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card rise-2 p-6">
          <h2 className="mb-4 font-semibold text-slate-900">可见性漏斗</h2>
          <div className="space-y-2">
            {data.funnel.map((s, i) => (
              <div key={s.key}>
                <div className="flex items-center justify-between text-xs">
                  <span>{s.label}</span>
                  <span className="metric-num text-slate-500">
                    {s.rate == null ? '—' : `${Math.round(s.rate * 100)}%`} ({s.numerator}/{s.denominator})
                  </span>
                </div>
                <div className="mt-1 h-2 rounded bg-slate-100">
                  <div
                    className="h-2 animate-grow-w rounded bg-gradient-to-r from-brand-400 to-brand-600"
                    style={{ width: `${(s.rate ?? 0) * 100}%` }}
                  />
                </div>
                {i > 0 && <p className="mt-0.5 text-[10px] text-slate-400">分母:{s.denominatorNote}</p>}
              </div>
            ))}
          </div>
        </div>

        <div className="card rise-3 p-6">
          <h2 className="mb-4 font-semibold text-slate-900">分引擎三率</h2>
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="py-1">引擎</th>
                <th className="py-1">提及</th>
                <th className="py-1">Top3</th>
                <th className="py-1">首推</th>
              </tr>
            </thead>
            <tbody className="metric-num">
              {data.engineStats.map((e) => (
                <tr key={e.engine} className="border-t">
                  <td className="py-1.5">{e.engine}</td>
                  <td>{pct2(e.mentionRate)}</td>
                  <td>{pct2(e.top3Rate)}</td>
                  <td>{pct2(e.top1Rate)}</td>
                </tr>
              ))}
              {data.engineStats.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    暂无采集数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <EvidenceModal runId={evidenceRun} onClose={() => setEvidenceRun(null)} />
    </div>
  );
}

function pct2(v: number) {
  return `${Math.round(v * 100)}%`;
}
