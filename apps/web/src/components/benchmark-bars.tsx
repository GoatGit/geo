'use client';

interface Benchmark {
  industry: string | null;
  mentionRate: number | null;
  top3Rate: number | null;
  top1Rate: number | null;
  brandCount: number;
  selfMentionRate: number | null;
}

/** 本品 vs 行业均值 对比条:提及率/Top3 率/首推率 三组,双色并列;
 *  只出行业均值不暴露他牌明细。领先/落后以色与箭头直读。 */
export function BenchmarkBars({ data, selfRates }: { data: Benchmark; selfRates: { mention: number | null; top3: number | null; top1: number | null } }) {
  const rows: Array<{ key: string; label: string; self: number | null; avg: number | null }> = [
    { key: 'mention', label: '提及率', self: selfRates.mention, avg: data.mentionRate },
    { key: 'top3', label: 'Top3 率', self: selfRates.top3, avg: data.top3Rate },
    { key: 'top1', label: '首推率', self: selfRates.top1, avg: data.top1Rate },
  ];
  return (
    <section className="card rise p-6">
      <h2 className="text-sm font-semibold text-slate-900">
        本品 vs 行业均值
        <span className="ml-2 text-xs font-normal text-slate-400">
          {data.industry} · 同行业 {data.brandCount} 个监测品牌(均值含本品;竞品主体数不在此列,见上方竞品总数)
        </span>
      </h2>
      <p className="mt-1 text-xs text-slate-500">藏青 = 本品,灰 = 行业均值(含本品);领先/落后箭头直观可读。</p>
      <div className="mt-4 space-y-4">
        {rows.map((r) => {
          const self = r.self ?? 0;
          const avg = r.avg ?? 0;
          const max = Math.max(self, avg, 0.01);
          const lead = self - avg;
          return (
            <div key={r.key}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="font-medium text-slate-700">{r.label}</span>
                <span className="metric-num">
                  <span className="font-semibold text-brand-700">{Math.round(self * 100)}%</span>
                  <span className="ml-2 text-slate-400">均值 {Math.round(avg * 100)}%</span>
                  {Math.abs(lead) >= 0.005 && (
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
