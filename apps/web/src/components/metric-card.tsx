'use client';

import { useState } from 'react';
import { useCountUp } from './motion';

type MetricCard = {
  metric: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  excludedFailed: number;
  excludedQuotaBlocked: number;
  /** 统计含最近有效回填的条数(docs/02 §1.1.1)>0 时提示语注明 */
  backfilled?: number;
  /** 该卡分母口径说明(不同卡分母不同,悬停对账用) */
  denominatorNote?: string;
  asOf: string;
  source: string;
};

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function isRateMetric(m: string): boolean {
  return m !== 'avgRank';
}

/** 迷你趋势线(docs/01 §3.3 指标卡近 7/30 天迷你趋势);null 断点自动跳过。 */
export function Sparkline({
  values,
  width = 104,
  height = 30,
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
}) {
  const pts = values.filter((v): v is number => v != null);
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    d += (d ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  const last = values[values.length - 1];
  const ly = last == null ? 0 : height - 3 - ((last - min) / span) * (height - 6);
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill="url(#spark-fill)" stroke="none" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={ly} r="2.4" fill="currentColor" />
    </svg>
  );
}

/**
 * 指标卡(docs/01 §3.3):数值进场动画 + 分子/分母口径徽章 + excluded 可见
 * (docs/00 教训 #5/#7:失败不静默、口径随手可查);空分母显示"待首轮采集"。
 */
export function MetricCardView({
  title,
  card,
  lowerBetter = false,
  spark,
  sparkLabel,
}: {
  title: string;
  card: MetricCard | undefined;
  lowerBetter?: boolean;
  spark?: Array<number | null>;
  sparkLabel?: string;
}) {
  if (!card) return null;
  return (
    <div className="card card-hover group relative overflow-hidden p-5">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-brand-400 to-sand-400 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <CardInner card={card} lowerBetter={lowerBetter} title={title} spark={spark} sparkLabel={sparkLabel} />
    </div>
  );
}

function CardInner({
  card,
  lowerBetter,
  title,
  spark,
  sparkLabel,
}: {
  card: MetricCard;
  lowerBetter: boolean;
  title: string;
  spark?: Array<number | null>;
  sparkLabel?: string;
}) {
  const animated = useCountUp(card.value);
  const [open, setOpen] = useState(false);
  const isEmpty = (card.denominator ?? 0) === 0;
  const display =
    card.value == null || isEmpty
      ? '—'
      : isRateMetric(card.metric)
        ? pct(animated ?? 0)
        : String(Math.round((animated ?? 0) * 100) / 100);
  // 面向用户的口径说明(点击 i 展开):不用内部术语,失败/拦截合并成一句人话
  const excludedTotal = (card.excludedFailed ?? 0) + (card.excludedQuotaBlocked ?? 0);

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{title}</span>
        <span className="relative inline-flex">
          <button
            type="button"
            aria-expanded={open}
            aria-label="统计口径说明(点击展开)"
            onClick={() => setOpen((v) => !v)}
            className={`flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[9px] font-bold transition-colors ${
              open ? 'bg-brand-100 text-brand-600' : 'bg-slate-100 text-slate-400 hover:bg-brand-100 hover:text-brand-600'
            }`}
          >
            i
          </button>
          {open && (
            <span className="pointer-events-none absolute right-0 top-6 z-30 block w-64 whitespace-normal rounded-lg border border-slate-100 bg-white px-3 py-2 text-left text-[11px] leading-5 font-normal text-slate-500 shadow-lg">
              <b className="font-semibold text-slate-700">
                {card.numerator ?? '—'}/{card.denominator ?? '—'}
              </b>
              {card.denominatorNote ? `(${card.denominatorNote})` : ''}
              {excludedTotal > 0 ? (
                <>
                  <br />
                  另有 {excludedTotal} 次提问没能成功获得 AI 回答(如超时、被拦截或当日额度用完),未计入
                </>
              ) : (
                ''
              )}
              {card.backfilled ? (
                <>
                  <br />
                  其中 {card.backfilled} 条沿用的是本时段之前最近一次有效结果
                </>
              ) : (
                ''
              )}
              <br />
              截至 {new Date(card.asOf).toLocaleString('zh-CN')}
            </span>
          )}
        </span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-8 text-slate-900">
        <span className="metric-num">{display}</span>
        {lowerBetter && card.value != null && !isEmpty && (
          <span className="ml-1 text-xs font-normal text-slate-400">越小越好</span>
        )}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-400">
          {isEmpty ? (
            <span className="text-slate-300">待首轮采集</span>
          ) : (
            <>
              <span className="metric-num">
                {card.numerator ?? '—'}/{card.denominator ?? '—'}
              </span>
              {card.excludedFailed + card.excludedQuotaBlocked > 0 && (
                <span className="ml-2 text-warn" title="这些提问没能成功获得 AI 回答,未计入统计">未获回答 {card.excludedFailed + card.excludedQuotaBlocked}</span>
              )}
            </>
          )}
        </div>
        {spark && spark.length >= 2 && (
          <div className="text-brand-600" title={sparkLabel ? `近 ${spark.length} 天${sparkLabel}趋势` : '趋势'}>
            <Sparkline values={spark} />
          </div>
        )}
      </div>
    </>
  );
}
