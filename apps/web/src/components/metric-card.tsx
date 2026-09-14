'use client';

import { useEffect, useState } from 'react';

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

function isRateMetric(m: string): boolean {
  return m !== 'avgRank';
}

/** 数值进场动画:600ms ease-out 递增(null 不动画)。 */
function useCountUp(target: number | null): number | null {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (target == null) return;
    let raf = 0;
    const start = performance.now();
    const dur = 650;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return target == null ? null : v;
}

/**
 * 指标卡(docs/01 §3.3):数值进场动画 + 分子/分母口径徽章 + excluded 可见
 * (docs/00 教训 #5/#7:失败不静默、口径随手可查);空分母显示"待首轮采集"。
 */
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
  return (
    <div className="card card-hover group relative overflow-hidden p-5">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-brand-400 to-sand-400 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <CardInner card={card} lowerBetter={lowerBetter} title={title} />
    </div>
  );
}

function CardInner({ card, lowerBetter, title }: { card: MetricCard; lowerBetter: boolean; title: string }) {
  const animated = useCountUp(card.value);
  const isEmpty = (card.denominator ?? 0) === 0;
  const display =
    card.value == null || isEmpty
      ? '—'
      : isRateMetric(card.metric)
        ? pct(animated ?? 0)
        : String(Math.round((animated ?? 0) * 100) / 100);

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{title}</span>
        <span
          className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-400 transition-colors hover:bg-brand-100 hover:text-brand-600"
          title={`分子/分母:${card.numerator ?? '—'}/${card.denominator ?? '—'};排除 failed=${card.excludedFailed}、quota_blocked=${card.excludedQuotaBlocked}(不计入分母);截至 ${new Date(card.asOf).toLocaleString('zh-CN')}`}
        >
          i
        </span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-8 text-slate-900">
        <span className="metric-num">{display}</span>
        {lowerBetter && card.value != null && !isEmpty && (
          <span className="ml-1 text-xs font-normal text-slate-400">越小越好</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        {isEmpty ? (
          <span className="text-slate-300">待首轮采集</span>
        ) : (
          <>
            <span className="metric-num">
              {card.numerator ?? '—'}/{card.denominator ?? '—'}
            </span>
            {card.excludedFailed + card.excludedQuotaBlocked > 0 && (
              <span className="ml-2 text-warn">排除 {card.excludedFailed + card.excludedQuotaBlocked}</span>
            )}
          </>
        )}
      </div>
    </>
  );
}
