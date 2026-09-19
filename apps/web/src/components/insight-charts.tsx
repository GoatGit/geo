'use client';

import type { InsightBlock } from '@geo/shared';

/**
 * 行业洞察图表渲染器(docs/01 §3.10 扩展):结构化 JSON → 内联 SVG/DOM,
 * 印刷风(白卡 + 藏青主色 + 橙色异常标注),零第三方图表依赖。
 */

const INK = '#0f172a';
const NAVY = '#1d3fae';
const BLUE = '#4c6bc6';
const GROUP_COLORS: Record<string, string> = { domestic: BLUE, intl: '#9aa3af', highlight: '#c2570b', normal: BLUE };
const GRAY = '#9aa3af';
const ORANGE = '#c2570b';
const TEAL = '#1f7a70';
const SERIES_COLORS = ['#1d4ed8', '#c2570b', '#15803d', '#7c3aed', '#b45309', '#0e7490'];

/**
 * 品牌稳定色:同名品牌在排行/象限/雷达等所有图表里同色(跨图可读性),
 * 取名做字符哈希映射色板,避免依赖渲染顺序。
 */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SERIES_COLORS[h % SERIES_COLORS.length]!;
}


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
  // 管理端手编 JSON 可能缺数组字段:守卫失败渲染占位,公开页不因脏数据白屏
  const arrays = {
    barRank: 'items' in b && Array.isArray(b.items) && b.items.length > 0,
    funnel: 'stages' in b && Array.isArray(b.stages) && b.stages.length > 0,
    heatmap: 'columns' in b && 'rows' in b && Array.isArray(b.columns) && b.columns.length > 0 && Array.isArray(b.rows) && b.rows.length > 0,
    radar: 'axes' in b && 'series' in b && Array.isArray(b.axes) && b.axes.length >= 3 && Array.isArray(b.series) && b.series.length > 0,
    trend: 'points' in b && Array.isArray(b.points) && b.points.length >= 2,
    scatter: 'points' in b && Array.isArray(b.points) && b.points.length > 0,
  } as Record<string, boolean>;
  if (b.type !== 'takeaway' && !arrays[b.type]) {
    return null;
  }
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
          <p className={`mt-1.5 whitespace-pre-line text-[15px] font-semibold leading-7 ${b.tone === 'warn' ? 'text-warn' : b.tone === 'good' ? 'text-good' : 'text-brand-700'}`}>
            {b.text}
          </p>
        </div>
      );
    case 'barRank':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><BarRankChart {...b} /></ChartCard>;
    case 'funnel':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><FunnelChart {...b} /></ChartCard>;
    case 'heatmap':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><HeatmapChart {...b} /></ChartCard>;
    case 'radar':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><RadarChart {...b} /></ChartCard>;
    case 'trend':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><TrendChart {...b} /></ChartCard>;
    case 'scatter':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><ScatterChart {...b} /></ChartCard>;
    default:
      return null;
  }
}

function ChartCard({ title, summary, note, children }: { title: string; summary?: string; note?: string; children: React.ReactNode }) {
  return (
    <figure className="card p-6">
      <figcaption>
        <h3 className="text-[17px] font-bold leading-6 text-slate-900">{title}</h3>
        {/* 图上总结:先给「所以呢」,再给图表;数据口径统一收进页脚,不在各图重复 */}
        {summary && <p className="mt-2 text-[13.5px] font-medium leading-6 text-slate-800">{summary}</p>}
        {note && <p className="mt-1 text-xs leading-5 text-slate-500">{note}</p>}
        <div className="mt-2 mb-4 h-0.5 rounded bg-brand-700" />
      </figcaption>
      {children}
    </figure>
  );
}

/* ===== 排行榜(横向条形,如「32 品牌 AI 可见度榜」) ===== */

function BarRankChart({ total, unit, items }: Extract<InsightBlock, { type: 'barRank' }>) {
  const max = Math.max(...items.map((it) => it.value ?? 0), 1);
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => {
        // 品牌条用稳定品牌色(跨图同色);group 语义色(highlight=橙/intl=灰)优先
        const color = it.group === 'highlight' ? ORANGE : it.group === 'intl' ? GRAY : nameColor(it.name);
        // 环比箭头(仅样本充足且上期有值的条目携带 delta)
        const delta =
          it.delta == null ? null : it.delta > 0 ? <span className="text-good">↑{it.delta.toFixed(1)}</span> : it.delta < 0 ? <span className="text-bad">↓{Math.abs(it.delta).toFixed(1)}</span> : <span className="text-slate-400">—</span>;
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
            {delta != null && <span className="metric-num w-12 shrink-0 text-[11px]">{delta}</span>}
            {it.n != null && (
              <span
                className="metric-num w-10 shrink-0 text-right text-[10px] text-slate-400"
                title={`该品牌有效回答 ${it.n} 条,样本量越小比率波动越大`}
              >
                n={it.n}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ===== AI 筛选漏斗(32 → 4 层层过滤) ===== */

function FunnelChart({ stages }: Extract<InsightBlock, { type: 'funnel' }>) {
  const base = stages[0]?.count || 1;
  // 逐层色相推进(藏青→蓝→青绿→橙):漏斗收口的稀缺感由色相对比表达,而非单色渐变
  const fills = ['#16298f', '#2544b8', TEAL, ORANGE, GRAY];
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
  const H = 380;
  const m = { l: 46, r: 24, t: 20, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  // 数据最大值再留 12% 头部空间:100% 的点不能贴边/出界
  const dataMax = Math.max(...points.map((p) => Math.max(p.x, p.y)), 0.5);
  const axisMax = Math.min(1.2, Math.ceil(dataMax * 1.12 * 10) / 10);
  const X = (v: number) => m.l + (v / axisMax) * iw;
  const Y = (v: number) => m.t + (1 - v / axisMax) * ih;
  const maxBySize = Math.max(...points.map((p) => p.size ?? 1), 1);
  const colorOf = (p: (typeof points)[number]) => {
    const g = groups?.find((x) => x.key === p.group);
    if (g?.color === 'accent') return ORANGE;
    if (g?.color === 'gray') return GRAY;
    if (g?.color === 'brand') return NAVY;
    return GROUP_COLORS[p.group ?? 'normal'] ?? BLUE;
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= axisMax + 1e-9);

  // 标签防重叠:大气泡标签画进气泡内;其余右/左/上依次找空位
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

  const bubbles = points.map((p) => {
    const r = 5 + ((p.size ?? 1) / maxBySize) * 9;
    return { p, r, cx: X(p.x), cy: Y(p.y) };
  });

  const labels = bubbles.map(({ p, r, cx, cy }) => {
    const w = Math.min(p.name.length * 11 + 14, 150);
    const h = 14;
    const color = colorOf(p);
    if (r >= 13) {
      placed.push({ x: cx - w / 2, y: cy - h / 2, w, h });
      return { key: p.name, x: cx, y: cy + 4, w, text: p.name, anchor: 'middle' as const, color: '#ffffff' };
    }
    let lx = cx + r + 4;
    let ly = cy - 7;
    if (lx + w > W - m.r || placed.some((b) => lx < b.x + b.w && lx + w > b.x && ly < b.y + h && ly + h > b.y)) {
      lx = cx - r - 4 - w;
      ly = cy - 7;
      if (lx < m.l || placed.some((b) => lx < b.x + b.w && lx + w > b.x && ly < b.y + h && ly + h > b.y)) {
        lx = Math.max(m.l, cx - w / 2);
        ly = cy - r - h - 2;
      }
    }
    lx = Math.max(m.l, Math.min(lx, W - m.r - w));
    placed.push({ x: lx, y: ly, w, h });
    return { key: p.name, x: lx, y: ly + 10, w, text: p.name, anchor: 'start' as const, color: color === GRAY ? '#64748b' : color };
  });

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={X(t)} y1={Y(0)} x2={X(t)} y2={Y(axisMax)} stroke="#eef2f7" />
            <line x1={X(0)} y1={Y(t)} x2={X(axisMax)} y2={Y(t)} stroke="#eef2f7" />
            <text x={X(t)} y={H - m.b + 16} textAnchor="middle" fontSize={10} fill="#94a3b8">{Math.round(t * 100)}%</text>
            <text x={m.l - 8} y={Y(t) + 3} textAnchor="end" fontSize={10} fill="#94a3b8">{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line x1={X(0)} y1={Y(0)} x2={X(axisMax)} y2={Y(0)} stroke="#cbd5e1" />
        <line x1={X(0)} y1={Y(0)} x2={X(0)} y2={Y(axisMax)} stroke="#cbd5e1" />
        {diagonal && <line x1={X(0)} y1={Y(0)} x2={X(axisMax)} y2={Y(axisMax)} stroke="#94a3b8" strokeDasharray="4 4" />}
        {bubbles.map(({ p, r, cx, cy }) => (
          <circle key={`b-${p.name}`} cx={cx} cy={cy} r={r} fill={colorOf(p)} fillOpacity={0.92} />
        ))}
        {labels.map((l, i) => (
          <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={11} fontWeight={600} fill={l.color}>
            {l.text}
          </text>
        ))}
        <text x={X(axisMax)} y={H - 6} textAnchor="end" fontSize={11} fill="#475569">{xLabel}</text>
        <text x={12} y={m.t - 6} fontSize={11} fill="#475569">{yLabel}</text>
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

