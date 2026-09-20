'use client';

/** 本品 vs 竞品均值 对比条:提及率/Top3 率/首推率 三组双色;
 *  均值 = 上方竞品榜单各竞品三率的算术平均,藏青 = 本品,灰 = 竞品均值。 */
export function BenchmarkBars({
  selfRates,
  avgRates,
}: {
  selfRates: { mention: number | null; top3: number | null; top1: number | null };
  avgRates: { mention: number | null; top3: number | null; top1: number | null };
}) {
  const rows: Array<{ key: string; label: string; self: number | null; avg: number | null }> = [
    { key: 'mention', label: '提及率', self: selfRates.mention, avg: avgRates.mention },
    { key: 'top3', label: 'Top3 率', self: selfRates.top3, avg: avgRates.top3 },
    { key: 'top1', label: '首推率', self: selfRates.top1, avg: avgRates.top1 },
  ];
  return (
    <section className="card rise p-6">
      <h2 className="text-sm font-semibold text-slate-900">
        本品 vs 竞品均值
        <span className="ml-2 text-xs font-normal text-slate-400">均值 = 上方榜单中各竞品三率的平均</span>
      </h2>
      <p className="mt-1 text-xs text-slate-500">藏青 = 本品,灰 = 竞品均值;领先/落后箭头直观可读。</p>
      <div className="mt-4 space-y-4">
        {rows.map((r) => {
          const self = r.self ?? 0;
          const avg = r.avg ?? 0;
          const max = Math.max(self, avg, 0.01);
          const lead = (r.self ?? 0) - (r.avg ?? 0);
          return (
            <div key={r.key}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="font-medium text-slate-700">{r.label}</span>
                <span className="metric-num">
                  <span className="font-semibold text-brand-700">{r.self == null ? '—' : `${Math.round(r.self * 100)}%`}</span>
                  <span className="ml-2 text-slate-400">均值 {r.avg == null ? '—' : `${Math.round(r.avg * 100)}%`}</span>
                  {r.self != null && r.avg != null && Math.abs(lead) >= 0.005 && (
                    <span className={`ml-2 font-semibold ${lead > 0 ? 'text-good' : 'text-bad'}`}>
                      {lead > 0 ? '↑' : '↓'}
                      {Math.abs(Math.round(lead * 1000) / 10)}pp
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="h-2.5 rounded bg-slate-100">
                  <div className="h-2.5 rounded bg-brand-700" style={{ width: `${(self / max) * 100}%` }} />
                </div>
                <div className="h-2.5 rounded bg-slate-100">
                  <div className="h-2.5 rounded bg-slate-300" style={{ width: `${(avg / max) * 100}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
