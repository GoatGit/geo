'use client';

type MetricCard = {
  metric: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  excludedFailed: number;
  excludedQuotaBlocked: number;
  asOf: string;
  source: string;
};

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

/** 指标卡(docs/01 §3.3):当日值 + 分子/分母口径徽章 + excluded 可见(教训 #5/#7 对策)。 */
export function MetricCardView({
  title,
  card,
  lowerBetter = false,
}: {
  title: string;
  card: MetricCard | undefined;
  lowerBetter?: boolean;
}) {
  if (!card) return null;
  const display =
    card.value == null
      ? '—'
      : metricIsRate(card.metric)
        ? pct(card.value)
        : String(card.value);
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{title}</span>
        <span
          className="cursor-help rounded bg-slate-100 px-1.5 text-[10px] text-slate-500"
          title={`分子/分母:${card.numerator ?? '—'}/${card.denominator ?? '—'};排除 failed=${card.excludedFailed}、quota_blocked=${card.excludedQuotaBlocked}(不计入分母);截至 ${new Date(card.asOf).toLocaleString('zh-CN')}`}
        >
          口径
        </span>
      </div>
      <div className={`mt-1 text-2xl font-semibold ${lowerBetter ? '' : ''}`}>
        <span className="metric-num">{display}</span>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        <span className="metric-num">
          {card.numerator ?? '—'}/{card.denominator ?? '—'}
        </span>
        {card.excludedFailed + card.excludedQuotaBlocked > 0 && (
          <span className="ml-2 text-warn">
            排除 {card.excludedFailed + card.excludedQuotaBlocked}
          </span>
        )}
      </div>
    </div>
  );
}

function metricIsRate(m: MetricCard['metric']): boolean {
  return m !== 'avgRank';
}
