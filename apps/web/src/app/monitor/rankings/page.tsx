'use client';
import { engineLabel, WEB_ENGINES } from '@geo/shared';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MetricCardView } from '@/components/metric-card';
import { EmptyState, PageHeader, Skeleton, pct } from '@/components/ui';
import { api, useBrandId, useRankings } from '@/lib/queries';
import { EvidenceModal } from '@/components/evidence-modal';
import { LayerSankey } from '@/components/layer-sankey';

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
  const [backfilling, setBackfilling] = useState(false);
  const brandId = useBrandId();
  const qc = useQueryClient();
  const { data, isLoading, error } = useRankings(days);

  if (isLoading) return <Skeleton />;
  if (error) {
    return <EmptyState title="数据加载失败" text={`${(error as Error).message} —— 请稍后重试,或在顶栏切换品牌。`} />;
  }
  if (!data) return <EmptyState text="暂无数据:完成品牌与问题配置后,首轮采集结果将在此展示" />;

  // 引擎列 = 窗口有数据的引擎 ∪ 矩阵单元格出现的引擎(尾部补齐可能带回窗口外引擎,
  // 只按 engineStats(纯窗口)取列会把回填单元格整列隐藏)。按 WEB_ENGINES 规范序排列。
  const matrixEngines: string[] = [
    ...WEB_ENGINES.filter((e) => data.matrix.some((r) => r.cells.some((c) => c.engine === e))),
    ...[...new Set(data.matrix.flatMap((r) => r.cells.map((c) => c.engine)))].filter(
      (e) => !WEB_ENGINES.includes(e as never),
    ),
  ];
  const allEngines = [...new Set([...data.engineStats.map((e) => e.engine), ...matrixEngines])];
  const visibleEngines = engineFilter === 'all' ? allEngines : [engineFilter];
  const visibleRows = data.matrix.filter(
    (r) => questionFilter === 'all' || String(r.questionId) === questionFilter,
  );
  const exportMatrix = (rows: typeof data.matrix, engines: string[]) => {
    const header = ['监控问题', ...engines, '综合名次', '提及率', 'Top3 率', '首推率'];
    const lines = rows.map((r) => {
      const cells = engines.map((eng) => {
        const c = r.cells.find((x) => x.engine === eng);
        if (!c) return '—';
        const base = c.rank !== null ? `#${c.rank}` : c.mentioned ? '提及·无排名' : '未提及';
        if (!c.stale) return base;
        const days = Math.floor((Date.now() - new Date(c.asOf ?? Date.now()).getTime()) / 86_400_000);
        return days >= 2 ? `${base}(${days})` : base;
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

      {/* 窗口回落提示:今日/近 N 天无新数据时自动展示更大窗口,旧数据不清空 */}
      {data.fallback && (
        <div className="rise rounded-lg border border-warn/30 bg-warn-50 px-4 py-2.5 text-xs leading-5 text-warn">
          <b>{data.fallback.requestedDays === 1 ? '今日' : `近 ${data.fallback.requestedDays} 天`}暂无新数据</b>
          {data.fallback.quotaBlocked > 0
            ? `(采集被配额拦截 ${data.fallback.quotaBlocked} 次,引擎额度按日恢复)`
            : data.fallback.failed > 0
              ? `(${data.fallback.failed} 次采集失败)`
              : '(本轮采集尚未完成)'}
          ——已为你展示<b>近 {data.fallback.actualDays} 天</b>的数据;次日额度恢复后自动切回。
        </div>
      )}

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
              <span className="w-20 shrink-0 truncate text-xs font-semibold text-slate-700">{engineLabel(e.engine)}</span>
              <div className="grid flex-1 gap-1">
                {RATE_BARS.map((b) => {
                  const v = e[b.key];
                  return (
                    <div key={b.key} className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                        <div
                          className={`h-1.5 rounded-full ${b.tone}`}
                          style={{ width: v != null ? `${Math.round(v * 100)}%` : 0 }}
                          title={v == null ? '该引擎窗口内无有效回答(非 0%)' : undefined}
                        />
                      </div>
                      <span className="metric-num w-10 text-right text-[11px] text-slate-500">
                        {v != null ? pct2(v) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {data.engineStats.length === 0 && <p className="text-sm text-slate-400">暂无采集数据</p>}
        </div>
      </section>

      {/* ===== 品牌洞察图表:问题层→结局 桑基(本品 vs 行业均值在竞品透视) ===== */}
      {data.layerSankey && data.layerSankey.length > 0 && <LayerSankey rows={data.layerSankey} />}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={engineFilter}
          onChange={(e) => setEngineFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm"
        >
          <option value="all">全部引擎</option>
          {allEngines.map((e) => (
            <option key={e} value={e}>{engineLabel(e)}</option>
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
          onClick={async () => {
            if (!window.confirm('用「首位评述」新口径重判历史数据:问题点名本品且回答主体为本品的回答将记为第 1 名(仅升级 null 位次,不降级)。先执行?此操作可能耗时 1-3 分钟。')) return;
            setBackfilling(true);
            try {
              const r = await api<{ scanned: number; changedRuns: number; changedFacts: number; dryRun: boolean }>(
                `/monitor/rankings/backfill`,
                { method: 'POST', json: { brandId, dryRun: false, limit: 300 } },
              );
              window.alert(`重判完成:扫描 ${r.scanned} 条,修正 ${r.changedRuns} 轮 / ${r.changedFacts} 条位次${r.dryRun ? '(试跑未写库)' : ''}`);
              void qc.invalidateQueries();
            } catch (e) {
              window.alert((e as Error).message);
            } finally {
              setBackfilling(false);
            }
          }}
          disabled={backfilling}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm hover:border-brand-300 disabled:opacity-40"
        >
          {backfilling ? '重判中…' : '重判历史排名'}
        </button>
        <button
          onClick={() => exportMatrix(data.matrix, allEngines)}
          className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm hover:border-brand-300"
        >
          导出 CSV
        </button>
        {/* 图例收进「?」提示:悬停/聚焦展开,单行呈现位次色标 + 综合名次口径 */}
        <span className="group relative ml-auto inline-flex">
          <button
            type="button"
            aria-label="矩阵图例与综合名次口径说明"
            className="flex h-[18px] w-[18px] cursor-help items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-400 transition-colors hover:bg-brand-100 hover:text-brand-600"
          >
            ?
          </button>
          <span className="pointer-events-none absolute right-0 top-6 z-20 hidden items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-100 bg-white px-3 py-2 text-[11px] text-slate-500 shadow-lg group-hover:flex group-focus-within:flex">
            <span className="metric-num rounded bg-good-50 px-1.5 py-0.5 text-good">#1</span>首推
            <span className="metric-num ml-1 rounded bg-brand-50 px-1.5 py-0.5 text-brand-700">#2-3</span>Top3
            <span className="metric-num ml-1 rounded bg-slate-100 px-1.5 py-0.5">#4+</span>靠后
            <span className="ml-1 rounded bg-slate-50 px-1.5 py-0.5 text-slate-400">提及·无排名</span>
            <span className="ml-1 rounded bg-bad-50 px-1.5 py-0.5 text-bad">未提及</span>
            <span className="ml-1 rounded bg-slate-50 px-1.5 py-0.5 text-slate-400">#3(3)</span>括号天数 = 数据距今天数(≥2 天才标,悬停可见;窗口内未采集时沿用最近一次有效结果,≤30 天)
            <span className="ml-1.5 border-l border-slate-100 pl-1.5 text-slate-400">综合名次 = 未提及记 N+1 取中位数;位次 = 榜单位次,或品牌评述题中的首位评述</span>
          </span>
        </span>
      </div>

      {/* ===== 全景矩阵 ===== */}
      <section className="table-wrap overflow-x-auto rounded-xl border border-slate-100">
        <table className="w-full border-collapse text-[12.5px]" style={{ borderSpacing: 0 }}>
          <thead>
            <tr className="bg-slate-50/90 text-[11.5px] font-semibold text-slate-500">
              <th className="sticky left-0 z-10 border-b border-slate-200 bg-slate-50/95 px-4 py-2.5 text-left backdrop-blur">监控问题</th>
              {visibleEngines.map((eng) => (
                <th key={eng} className="border-b border-slate-200 px-2.5 py-2.5 text-center">{engineLabel(eng)}</th>
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
                  // 回填陈旧度小标:≥2 天才显示 (N),悬停说明;0/1 天(近窗口)不标
                  const staleDays = cell?.stale && cell.asOf ? Math.floor((Date.now() - new Date(cell.asOf).getTime()) / 86_400_000) : null;
                  const staleMark = staleDays != null && staleDays >= 2 ? staleDays : null;
                  return (
                    <td key={eng} className="border-t border-slate-100 px-2.5 py-2 text-center">
                      {!cell ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button
                          disabled={!cell.runId}
                          onClick={() => cell.runId && setEvidenceRun(cell.runId)}
                          title={
                            (cell.runId ? '点击查看该引擎的 AI 回答原文与存证' : '该单元格暂无可回溯的采集记录') +
                            (cell.stale ? `(窗口内未采集,数据截至 ${new Date(cell.asOf ?? Date.now()).toLocaleString('zh-CN')})` : '')
                          }
                          className={`rounded transition-transform ${
                            cell.runId ? 'hover:-translate-y-px hover:shadow-sm' : 'cursor-default'
                          }`}
                        >
                          {cell.rank !== null ? (
                            <span
                              className={`metric-num inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs ${
                                cell.rank === 1
                                  ? 'bg-good-50 text-good'
                                  : cell.rank <= 3
                                    ? 'bg-brand-50 text-brand'
                                    : 'bg-slate-100 text-slate-600'
                              } ${cell.stale ? 'opacity-70' : ''}`}
                            >
                              #{cell.rank}
                              {cell.prevRank != null && cell.rank !== cell.prevRank && !cell.stale && (
                                <span className={cell.rank < cell.prevRank ? 'text-good' : 'text-bad'}>
                                  {cell.rank < cell.prevRank ? '▲' : '▼'}
                                </span>
                              )}
                              {staleMark != null && <StaleMark days={staleMark} />}
                            </span>
                          ) : cell.mentioned ? (
                            <span
                              className={`block cursor-help px-1 py-0.5 text-xs ${cell.stale ? 'text-slate-400/80' : 'text-slate-400'}`}
                              title="AI 回答提及了本品,但该回答是开放式评述、未给出推荐位次(排名类指标不计入此类)"
                            >
                              提及·无排名
                              {staleMark != null && <StaleMark days={staleMark} />}
                            </span>
                          ) : cell.stale ? (
                            <span
                              className="block cursor-help rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-400"
                              title={
                                staleMark != null
                                  ? `${staleMark} 天前的采集数据(本窗口内未重新采集)中未出现本品`
                                  : `最近一次有效采集(${new Date(cell.asOf ?? Date.now()).toLocaleString('zh-CN')})中未出现本品;本窗口内尚未重新采集`
                              }
                            >
                              未提及{staleMark != null && <StaleMark days={staleMark} />}
                            </span>
                          ) : (
                            <span
                              className="block cursor-help rounded bg-bad-50 px-1.5 py-0.5 text-xs text-bad"
                              title="该条 AI 回答未出现本品"
                            >
                              未提及
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="metric-num border-l-2 border-slate-200 border-t border-t-slate-100 px-3 py-2 text-center font-semibold">
                  {row.compositeRank != null ? `第${row.compositeRank}名` : '30天内未采集'}
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

/** 回填陈旧度 (N) 小标:点击展开说明(悬停不弹;原生 title 在内嵌浏览器不渲染) */
function StaleMark({ days }: { days: number }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <span
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${days} 天前的数据说明(点击展开)`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={`cursor-help text-[10px] font-normal ${open ? 'text-brand-600' : 'text-slate-400'}`}
      >
        ({days})
      </span>
      {open && (
        <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 block -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-100 bg-white px-2.5 py-1.5 text-[11px] font-normal text-slate-500 shadow-lg">
          {days} 天前采集的数据(这段时间内没有重新采集)
        </span>
      )}
    </span>
  );
}
