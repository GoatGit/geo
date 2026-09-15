'use client';

import type { InsightBlock } from '@geo/shared';

/**
 * 行业洞察图表渲染器(docs/01 §3.10 扩展):结构化 JSON → 内联 SVG/DOM,
 * 印刷风(白卡 + 藏青主色 + 橙色异常标注),零第三方图表依赖。
 */

const INK = '#0f172a';
const NAVY = '#1d3fae';
const BLUE = '#4c6bc6';
const GRAY = '#9aa3af';
const ORANGE = '#c2570b';
const SERIES_COLORS = ['#1d4ed8', '#c2570b', '#15803d', '#7c3aed', '#b45309'];

const GROUP_COLORS: Record<string, string> = {
  domestic: BLUE,
  intl: GRAY,
  highlight: ORANGE,
  normal: BLUE,
};

export function InsightBlocks({ blocks }: { blocks: InsightBlock[] }) {
  return (
    <div className="space-y-5">
      {blocks.map((b, i) => (
        <InsightBlockView key={i} block={b} />
      ))}
    </div>
  );
}

export function InsightBlockView({ block: b }: { block: InsightBlock }) {
  switch (b.type) {
    case 'takeaway':
      return (
        <div
          className={`rounded-xl border-l-4 p-5 ${
            b.tone === 'warn'
              ? 'border-warn bg-warn-50'
              : b.tone === 'good'
                ? 'border-good bg-good-50'
                : 'border-brand-600 bg-brand-50'
          }`}
        >
          <p className="text-[11px] font-medium uppercase tracking-widest text-slate-500">{b.title}</p>
          <p className={`mt-1.5 text-[15px] font-semibold leading-7 ${b.tone === 'warn' ? 'text-warn' : b.tone === 'good' ? 'text-good' : 'text-brand-700'}`}>
            {b.text}
          </p>
        </div>
      );
    case 'barRank':
      return <ChartCard title={b.title} note={b.note}><BarRankChart {...b} /></ChartCard>;
    case 'funnel':
      return <ChartCard title={b.title} note={b.note}><FunnelChart {...b} /></ChartCard>;
    case 'heatmap':
      return <ChartCard title={b.title} note={b.note}><HeatmapChart {...b} /></ChartCard>;
    case 'radar':
      return <ChartCard title={b.title} note={b.note}><RadarChart {...b} /></ChartCard>;
    case 'trend':
      return <ChartCard title={b.title} note={b.note}><TrendChart {...b} /></ChartCard>;
    case 'scatter':
      return <ChartCard title={b.title} note={b.note}><ScatterChart {...b} /></ChartCard>;
    default:
      return null;
  }
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <figure className="card p-6">
      <figcaption>
        <h3 className="text-[17px] font-bold leading-6 text-slate-900">{title}</h3>
        {note && <p className="mt-1 text-xs leading-5 text-slate-500">{note}</p>}
        <div className="mt-2 mb-4 h-0.5 rounded bg-brand-700" />
      </figcaption>
      {children}
    </figure>
  );
}

/* ===== 排行榜(横向条形,如「32 品牌 AI 可见度榜」) ===== */

function BarRankChart({ total, unit, items }: Extract<InsightBlock, { type: 'barRank' }>) {
  const max = Math.max(...items.map((it) => it.value), 1);
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => {
        const color = it.group === 'intl' ? GRAY : it.group === 'highlight' ? ORANGE : i === 0 ? NAVY : BLUE;
        return (
          <div key={it.name} className="flex items-center gap-2.5 text-[13px]">
            <span className="metric-num w-6 shrink-0 text-right text-slate-400">{i + 1}</span>
            <span className={`w-24 shrink-0 truncate font-medium ${it.group === 'highlight' ? 'text-orange-700' : 'text-slate-800'}`}>{it.name}</span>
            <div className="h-4 flex-1 overflow-hidden rounded-sm bg-slate-100">
              <div className="h-full rounded-sm" style={{ width: `${(it.value / max) * 100}%`, backgroundColor: color }} />
            </div>
            <span className="metric-num w-16 shrink-0 text-right font-medium" style={{ color: it.group === 'highlight' ? ORANGE : INK }}>
              {unit === '%' ? `${it.value}%` : `${it.value}/${total}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ===== AI 筛选漏斗(32 → 4 层层过滤) ===== */

function FunnelChart({ stages }: Extract<InsightBlock, { type: 'funnel' }>) {
  const base = stages[0]?.count || 1;
  const fills = ['#16298f', '#2544b8', '#4c6bc6', '#7c93d8', '#a8b9e8'];
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const pct = Math.round((s.count / base) * 1000) / 10;
        return (
          <div key={s.label} className="flex items-center gap-4">
            <div className="flex h-14 flex-[3] items-center justify-between rounded-lg px-4" style={{ width: `${Math.max(28, (s.count / base) * 100)}%`, backgroundColor: fills[i % fills.length] }}>
              <span className="metric-num text-xl font-bold text-white">{s.count}</span>
              {i > 0 && <span className="metric-num text-xs font-medium text-white/85">{pct}%</span>}
            </div>
            <div className="flex-[2]">
              <p className="text-[13px] font-semibold text-slate-800">{s.label}</p>
              <p className="text-xs leading-4 text-slate-500">{s.note}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ===== 品牌 × 维度命中热力图 ===== */

function HeatmapChart({ columns, rows }: Extract<InsightBlock, { type: 'heatmap' }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-center text-xs">
        <thead>
          <tr>
            <th className="p-2 text-left font-medium text-slate-500">品牌</th>
            {columns.map((c) => (
              <th key={c} className="p-2 font-medium text-slate-600">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="p-1.5 text-left text-[13px] font-medium text-slate-800">{r.name}</td>
              {r.cells.map((v, ci) => (
                <td key={ci} className="p-1">
                  {v == null ? (
                    <div className="rounded bg-slate-50 py-2 text-slate-300">—</div>
                  ) : (
                    <div
                      className="rounded py-2 font-semibold"
                      style={{
                        backgroundColor: v === 0 ? '#f8fafc' : `rgba(29, 63, 174, ${0.12 + v * 0.88})`,
                        color: v > 0.55 ? '#ffffff' : '#334155',
                      }}
                    >
                      {Math.round(v * 100)}%
                    </div>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ===== 前五品牌维度形状(雷达) ===== */

function RadarChart({ axes, series }: Extract<InsightBlock, { type: 'radar' }>) {
  const W = 420;
  const H = 320;
  const cx = W / 2 - 40;
  const cy = H / 2 + 8;
  const R = 100;
  const n = axes.length;
  const pt = (ai: number, v: number): [number, number] => {
    const ang = (Math.PI * 2 * ai) / n - Math.PI / 2;
    return [cx + R * v * Math.cos(ang), cy + R * v * Math.sin(ang)];
  };
  const ring = (v: number) => axes.map((_, ai) => pt(ai, v).join(',')).join(' ');
  return (
    <div className="flex flex-wrap items-start gap-4">
      <svg viewBox={`0 0 ${W - 70} ${H}`} className="w-full max-w-[350px]" role="img">
        {[0.25, 0.5, 0.75, 1].map((v) => (
          <polygon key={v} points={ring(v)} fill="none" stroke="#e2e8f0" strokeWidth={v === 1 ? 1.2 : 0.8} strokeDasharray={v === 1 ? undefined : '3 3'} />
        ))}
        {axes.map((a, ai) => {
          const [x, y] = pt(ai, 1);
          const [lx, ly] = pt(ai, 1.22);
          return (
            <g key={a}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="#e2e8f0" strokeWidth={0.8} />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#475569">{a}</text>
            </g>
          );
        })}
        {series.map((s, si) => (
          <polygon
            key={s.name}
            points={s.values.map((v, ai) => pt(ai, v).join(',')).join(' ')}
            fill={SERIES_COLORS[si % SERIES_COLORS.length]}
            fillOpacity={0.1}
            stroke={SERIES_COLORS[si % SERIES_COLORS.length]}
            strokeWidth={1.8}
          />
        ))}
      </svg>
      <ul className="mt-6 space-y-1.5 text-xs text-slate-600">
        {series.map((s, si) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS[si % SERIES_COLORS.length] }} />
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ===== 每日趋势(折线,null 断线) ===== */

function TrendChart({ unit, points }: Extract<InsightBlock, { type: 'trend' }>) {
  const W = 520;
  const H = 220;
  const m = { l: 40, r: 14, t: 12, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const isPct = unit === '%';
  const maxV = isPct ? 100 : Math.max(...points.map((p) => p.value ?? 0), 1);
  const X = (i: number) => m.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const Y = (v: number) => m.t + (1 - v / maxV) * ih;
  const segments: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (cur.length > 0) segments.push(cur);
      cur = [];
      return;
    }
    cur.push([X(i), Y(p.value)]);
  });
  if (cur.length > 0) segments.push(cur);
  const step = Math.max(1, Math.ceil(points.length / 8));
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={m.l} y1={Y(maxV * t)} x2={W - m.r} y2={Y(maxV * t)} stroke="#eef2f7" />
            <text x={m.l - 6} y={Y(maxV * t) + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
              {isPct ? `${Math.round(maxV * t)}%` : Math.round(maxV * t)}
            </text>
          </g>
        ))}
        <line x1={m.l} y1={m.t + ih} x2={W - m.r} y2={m.t + ih} stroke="#cbd5e1" />
        {segments.map((seg, gi) => (
          <g key={gi}>
            {seg.length > 2 && (
              <polygon
                points={`${seg.map(([x, y]) => `${x},${y}`).join(' ')} ${seg[seg.length - 1][0]},${m.t + ih} ${seg[0][0]},${m.t + ih}`}
                fill={NAVY}
                fillOpacity={0.06}
              />
            )}
            <polyline points={seg.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke={NAVY} strokeWidth={1.8} />
            {seg.map(([x, y], pi) => (
              <circle key={pi} cx={x} cy={y} r={2.4} fill={NAVY} />
            ))}
          </g>
        ))}
        {points.map((p, i) =>
          i % step === 0 || i === points.length - 1 ? (
            <text key={i} x={X(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#94a3b8">{p.label}</text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/* ===== 行业层 × 场景层散点(可带对角线与气泡) ===== */

function ScatterChart({ xLabel, yLabel, diagonal, points, groups }: Extract<InsightBlock, { type: 'scatter' }>) {
  const W = 520;
  const H = 360;
  const m = { l: 46, r: 20, t: 14, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const X = (v: number) => m.l + v * iw;
  const Y = (v: number) => m.t + (1 - v) * ih;
  const maxBySize = Math.max(...points.map((p) => p.size ?? 1), 1);
  const colorOf = (p: (typeof points)[number]) => {
    const g = groups?.find((x) => x.key === p.group);
    if (g?.color === 'accent') return ORANGE;
    if (g?.color === 'gray') return GRAY;
    if (g?.color === 'brand') return NAVY;
    return GROUP_COLORS[p.group ?? 'normal'] ?? BLUE;
  };
  const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const maxTick = Math.max(0.5, ...points.map((p) => Math.max(p.x, p.y))) + 0.05;
  const axisMax = Math.ceil(maxTick * 10) / 10;
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img">
        {ticks.filter((t) => t <= axisMax).map((t) => (
          <g key={t}>
            <line x1={X(t / axisMax)} y1={Y(0)} x2={X(t / axisMax)} y2={Y(axisMax)} stroke="#eef2f7" />
            <line x1={X(0)} y1={Y(t / axisMax)} x2={X(axisMax)} y2={Y(t / axisMax)} stroke="#eef2f7" />
            <text x={X(t / axisMax)} y={H - m.b + 16} textAnchor="middle" fontSize={10} fill="#94a3b8">{Math.round(t * 100)}%</text>
            <text x={m.l - 8} y={Y(t / axisMax) + 3} textAnchor="end" fontSize={10} fill="#94a3b8">{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line x1={X(0)} y1={Y(0)} x2={X(axisMax)} y2={Y(0)} stroke="#cbd5e1" />
        <line x1={X(0)} y1={Y(0)} x2={X(0)} y2={Y(axisMax)} stroke="#cbd5e1" />
        {diagonal && (
          <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} stroke="#94a3b8" strokeDasharray="4 4" />
        )}
        {points.map((p) => {
          const r = 5 + ((p.size ?? 1) / maxBySize) * 9;
          return (
            <g key={p.name}>
              <circle cx={X(p.x)} cy={Y(p.y)} r={r} fill={colorOf(p)} fillOpacity={0.92} />
              <text x={X(p.x) + r + 4} y={Y(p.y) + 3} fontSize={11} fontWeight={600} fill={colorOf(p) === GRAY ? '#64748b' : colorOf(p)}>
                {p.name}
                {p.note ? ` ${p.note}` : ''}
              </text>
            </g>
          );
        })}
        <text x={X(axisMax)} y={H - 6} textAnchor="end" fontSize={11} fill="#475569">{xLabel}</text>
        <text x={12} y={m.t - 2} fontSize={11} fill="#475569">{yLabel}</text>
      </svg>
      {groups && groups.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-4 text-xs text-slate-600">
          {groups.map((g) => (
            <li key={g.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color === 'accent' ? ORANGE : g.color === 'gray' ? GRAY : NAVY }} />
              {g.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5 text-slate-400">气泡越大 = 总命中越多</li>
        </ul>
      )}
    </div>
  );
}
