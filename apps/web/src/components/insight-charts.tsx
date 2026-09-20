'use client';

import { ENGINE_LABELS, type InsightBlock, type InsightDrill } from '@geo/shared';

/** 引擎中文名 → slug 反查(热力图列点击下钻用)。 */
const ENGINE_BY_LABEL: Record<string, string> = Object.entries(ENGINE_LABELS).reduce(
  (m, [slug, label]) => {
    m[label] = slug;
    return m;
  },
  {} as Record<string, string>,
);

/**
 * 行业洞察图表渲染器(docs/01 §3.10 扩展):结构化 JSON → 内联 SVG/DOM,
 * 印刷风(白卡 + 藏青主色 + 橙色异常标注),零第三方图表依赖。
 */

const INK = '#0f172a';
const NAVY = '#1d3fae';
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


type TakeawayRow = Extract<InsightBlock, { type: 'takeaway' }>;

export function InsightBlocks({ blocks, onDrill }: { blocks: InsightBlock[]; onDrill?: (d: InsightDrill) => void }) {
  // 连续文字块(takeaway)合并为一张「核心要点」卡:报告首屏不被文字墙占满,
  // 顺序保留——非文字块之间夹着的独立文字块照常单卡渲染
  const groups: Array<InsightBlock | TakeawayRow[]> = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (b.type === 'takeaway' && Array.isArray(last)) last.push(b);
    else if (b.type === 'takeaway') groups.push([b]);
    else groups.push(b);
  }
  return (
    <div className="space-y-5">
      {groups.map((g, i) =>
        Array.isArray(g) ? <TakeawayGroup key={i} rows={g} /> : <InsightBlockView key={i} block={g} onDrill={onDrill} />,
      )}
    </div>
  );
}

/** 语气色:品牌蓝 / 警示橙 / 正面青绿,标题与圆点同色便于扫读。 */
const TONE_COLOR: Record<string, string> = { brand: NAVY, warn: ORANGE, good: TEAL };

function TakeawayGroup({ rows }: { rows: TakeawayRow[] }) {
  const multi = rows.length > 1;
  return (
    <div className="card p-5">
      {multi && (
        <div className="mb-3 flex items-baseline gap-2 border-b border-slate-100 pb-2">
          <h3 className="text-[15px] font-bold text-slate-900">核心要点</h3>
          <span className="metric-num text-[11px] text-slate-400">{rows.length} 条</span>
        </div>
      )}
      <div className={multi ? 'space-y-3.5' : ''}>
        {rows.map((r) => {
          const tone = TONE_COLOR[r.tone ?? 'brand'] ?? NAVY;
          return (
            <div key={r.title} className="flex gap-2.5">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tone }} />
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold leading-5" style={{ color: tone }}>
                  {r.title}
                </p>
                <p className="mt-0.5 text-[13px] leading-6 text-slate-600">{r.text}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InsightBlockView({ block: b, onDrill }: { block: InsightBlock; onDrill?: (d: InsightDrill) => void }) {
  // 管理端手编 JSON 可能缺数组字段:守卫失败渲染占位,公开页不因脏数据白屏
  const arrays = {
    barRank: 'items' in b && Array.isArray(b.items) && b.items.length > 0,
    funnel: 'stages' in b && Array.isArray(b.stages) && b.stages.length > 0,
    heatmap: 'columns' in b && 'rows' in b && Array.isArray(b.columns) && b.columns.length > 0 && Array.isArray(b.rows) && b.rows.length > 0,
    radar: 'axes' in b && 'series' in b && Array.isArray(b.axes) && b.axes.length >= 3 && Array.isArray(b.series) && b.series.length > 0,
    trend: 'points' in b && Array.isArray(b.points) && b.points.length >= 2,
    scatter: 'points' in b && Array.isArray(b.points) && b.points.length > 0,
    sankey:
      'left' in b && 'right' in b && 'links' in b &&
      Array.isArray(b.left) && b.left.length >= 2 && Array.isArray(b.right) && b.right.length >= 2 && Array.isArray(b.links) && b.links.length > 0,
  } as Record<string, boolean>;
  if (b.type !== 'takeaway' && !arrays[b.type]) {
    return null;
  }
  switch (b.type) {
    case 'takeaway':
      return <TakeawayGroup rows={[b]} />;
    case 'barRank':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><BarRankChart {...b} onDrill={onDrill} /></ChartCard>;
    case 'funnel':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><FunnelChart {...b} /></ChartCard>;
    case 'heatmap':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><HeatmapChart {...b} onDrill={onDrill} /></ChartCard>;
    case 'radar':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><RadarChart {...b} /></ChartCard>;
    case 'trend':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><TrendChart {...b} /></ChartCard>;
    case 'scatter':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><ScatterChart {...b} /></ChartCard>;
    case 'sankey':
      return <ChartCard title={b.title} summary={b.summary} note={b.note}><SankeyChart {...b} onDrill={onDrill} /></ChartCard>;
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

function BarRankChart({ total, unit, items, onDrill }: Extract<InsightBlock, { type: 'barRank' }> & { onDrill?: (d: InsightDrill) => void }) {
  const max = Math.max(...items.map((it) => it.value ?? 0), 1);
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => {
        // 品牌条用稳定品牌色(跨图同色);group 语义色(highlight=橙/intl=灰)优先
        const color = it.group === 'highlight' ? ORANGE : it.group === 'intl' ? GRAY : nameColor(it.name);
        // 环比箭头(仅样本充足且上期有值的条目携带 delta)
        const delta =
          it.delta == null ? null : it.delta > 0 ? <span className="text-good">↑{it.delta.toFixed(1)}</span> : it.delta < 0 ? <span className="text-bad">↓{Math.abs(it.delta).toFixed(1)}</span> : <span className="text-slate-400">—</span>;
        const drillable = !!(it.drill && onDrill);
        return (
          <div
            key={it.name}
            className={`flex items-center gap-2.5 rounded-md text-[13px] ${drillable ? 'cursor-pointer px-1 py-0.5 -mx-1 transition-colors hover:bg-brand-50' : ''}`}
            title={drillable ? '点击查看该条目的事实明细(原始回答摘录)' : undefined}
            onClick={drillable ? () => onDrill?.(it.drill!) : undefined}
          >
            <span className="metric-num w-6 shrink-0 text-right text-slate-400">{i + 1}</span>
            <span className={`w-24 shrink-0 truncate font-medium ${it.group === 'highlight' ? 'text-orange-700' : 'text-slate-800'}`}>{it.name}</span>
            <div className="h-4 flex-1 overflow-hidden rounded-sm bg-slate-100">
              <div className="h-full rounded-sm" style={{ width: `${(it.value / max) * 100}%`, backgroundColor: color }} />
            </div>
            <span
              className="metric-num w-[76px] shrink-0 text-right font-medium"
              style={{ color: it.group === 'highlight' ? ORANGE : INK }}
              title={it.n != null ? `${it.value}${unit === '%' ? '%' : `/${total}`} / 样本量 ${it.n}(样本越小比率波动越大)` : undefined}
            >
              {unit === '%' ? `${it.value}%` : `${it.value}/${total}`}
              {it.n != null && <span className="text-[10px] font-normal text-slate-400">/{it.n}</span>}
            </span>
            {delta != null && <span className="metric-num w-12 shrink-0 text-[11px]">{delta}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ===== AI 筛选漏斗(32 → 4 层层过滤) ===== */

function FunnelChart({ stages }: Extract<InsightBlock, { type: 'funnel' }>) {
  const base = stages[0]?.count || 1;
  // 逐层色相推进(藏青→蓝→青绿→橙):漏斗收口的稀缺感由色相对比表达
  const fills = ['#16298f', '#2544b8', TEAL, ORANGE, GRAY];
  return (
    <div className="space-y-1">
      {stages.map((s, i) => {
        const pct = Math.round((s.count / base) * 1000) / 10;
        const w = (s.count / base) * 100;
        const inside = w >= 30; // 数值放条内(白字)或条外(深字)
        return (
          <div key={s.label} className="flex items-center gap-3">
            {/* 标签列:层级名 + 说明,固定宽度对齐 */}
            <div className="w-44 shrink-0 text-right">
              <p className="text-xs font-semibold leading-4 text-slate-800">{s.label}</p>
              <p className="text-[10px] leading-3 text-slate-400">{s.note}</p>
            </div>
            {/* 比例轨道:宽度=真实占比(flex 子项不能带 grow,否则等长),细条兜底可读 */}
            <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-slate-100/80">
              <div
                className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md px-2"
                style={{ width: `${Math.max(w, 2)}%`, backgroundColor: fills[i % fills.length] }}
              >
                {inside && (
                  <span className="metric-num text-xs font-bold text-white">
                    {s.count}
                    {i > 0 && <span className="ml-1 font-medium text-white/80">{pct}%</span>}
                  </span>
                )}
              </div>
              {!inside && (
                <span className="metric-num absolute top-1/2 -translate-y-1/2 text-xs font-bold text-slate-700" style={{ left: `calc(${Math.max(w, 2)}% + 6px)` }}>
                  {s.count}
                  <span className="ml-1 font-medium text-slate-400">{pct}%</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}


/* ===== 品牌 × 维度命中热力图 ===== */

function HeatmapChart({ columns, rows, columnKind, deltas, onDrill }: Extract<InsightBlock, { type: 'heatmap' }> & { onDrill?: (d: InsightDrill) => void }) {
  // 格子点击 → 该品牌在该列(引擎/问题层)的命中明细
  const cellDrill = (name: string, col: string): InsightDrill | null => {
    if (!onDrill || !columnKind) return null;
    if (columnKind === 'engine') {
      const slug = ENGINE_BY_LABEL[col] ?? col;
      return { kind: 'mentions', subject: name, engine: slug };
    }
    return { kind: 'mentions', subject: name, layer: col };
  };
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
          {rows.map((r, ri) => (
            <tr key={r.name}>
              <td className="p-1.5 text-left text-[13px] font-medium text-slate-800">{r.name}</td>
              {r.cells.map((v, ci) => {
                const drill = v != null ? cellDrill(r.name, columns[ci]!) : null;
                const d = deltas?.[ri]?.[ci];
                return (
                <td key={ci} className="p-1">
                  {v == null ? (
                    <div className="rounded bg-slate-50 py-2 text-slate-300">—</div>
                  ) : (
                    <div
                      className={`relative rounded py-2 font-semibold ${drill ? 'cursor-pointer outline-offset-1 hover:outline hover:outline-1 hover:outline-brand-400' : ''}`}
                      style={{
                        backgroundColor: v === 0 ? '#f8fafc' : `rgba(29, 63, 174, ${0.12 + v * 0.88})`,
                        color: v > 0.55 ? '#ffffff' : '#334155',
                      }}
                      title={drill ? '点击查看该格的命中明细(原始回答摘录)' : undefined}
                      onClick={drill ? () => onDrill?.(drill) : undefined}
                    >
                      {Math.round(v * 100)}%
                      {/* 期际变化角标(rubric 2.9):↑绿 ↓红,深色格用白字 */}
                      {d != null && (
                        <span
                          className={`metric-num absolute right-1 top-0.5 text-[9px] font-bold ${v > 0.55 ? 'text-white/80' : d > 0 ? 'text-good' : 'text-bad'}`}
                          title={`较上期 ${d > 0 ? '+' : ''}${d} 个百分点`}
                        >
                          {d > 0 ? '↑' : '↓'}{Math.abs(d)}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {deltas && deltas.some((row) => row.some((d) => d != null)) && (
        <p className="mt-2 text-[10px] text-slate-400">角标 = 较上期变化(百分点,±0.5 以内不标)。</p>
      )}
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
  const hasDeltas = series.some((s) => Array.isArray(s.deltas) && s.deltas.some((d) => d != null));
  // 轴短名(变动表列头,五维固定序与组稿器一致)
  const axisShort = ['提及', 'Top3', '首位', '口碑', '被引'];
  return (
    <div>
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
        {series.map((s) => (
          <polygon
            key={s.name}
            points={s.values.map((v, ai) => pt(ai, v).join(',')).join(' ')}
            fill={nameColor(s.name)}
            fillOpacity={0.1}
            stroke={nameColor(s.name)}
            strokeWidth={1.8}
          />
        ))}
      </svg>
      <ul className="mt-6 space-y-1.5 text-xs text-slate-600">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: nameColor(s.name) }} />
            {s.name}
          </li>
        ))}
      </ul>
      </div>
      {/* 各轴较上期变化(rubric 2.9):↑绿 ↓红,±0.5pp 以内不标 */}
      {hasDeltas && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-center text-[11px]">
            <thead>
              <tr className="text-slate-400">
                <th className="p-1.5 text-left font-medium">较上期(百分点)</th>
                {axes.map((a, i) => (
                  <th key={a} className="p-1.5 font-medium">{axisShort[i] ?? a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.name} className="border-t border-slate-50">
                  <td className="p-1.5 text-left font-medium text-slate-700">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: nameColor(s.name) }} />
                    {s.name}
                  </td>
                  {axes.map((a, i) => {
                    const d = s.deltas?.[i];
                    return (
                      <td key={a} className="metric-num p-1.5">
                        {d == null ? <span className="text-slate-300">—</span> : <span className={d > 0 ? 'font-semibold text-good' : 'font-semibold text-bad'}>{d > 0 ? '↑' : '↓'}{Math.abs(d)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  // 气泡默认用品牌稳定色(与排行/桑基跨图同色);显式分组语义色优先
  const colorOf = (p: (typeof points)[number]) => {
    const g = groups?.find((x) => x.key === p.group);
    if (g?.color === 'accent' || p.group === 'highlight') return ORANGE;
    if (g?.color === 'gray' || p.group === 'intl') return GRAY;
    if (g?.color === 'brand') return NAVY;
    return nameColor(p.name);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= axisMax + 1e-9);

  // 标签防重叠:短名画进气泡内(白字),其余右/左/上依次找空位
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  // 文本宽估算:CJK ≈ 1 字号,拉丁 ≈ 0.58 字号
  const textW = (s: string, fs: number) =>
    fs * [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0);

  const bubbles = points.map((p, i) => {
    const r = 4.5 + ((p.size ?? 1) / maxBySize) * 8;
    const cx = X(p.x);
    const cy = Y(p.y);
    // 与其他气泡显著重叠的不放内嵌白字(会压到邻泡上不可读)
    const isolated = !points.some((_, j) => {
      if (j === i) return false;
      const o = { cx: X(points[j]!.x), cy: Y(points[j]!.y), r: 4.5 + ((points[j]!.size ?? 1) / maxBySize) * 8 };
      return Math.hypot(o.cx - cx, o.cy - cy) < (o.r + r) * 0.85;
    });
    return { p, r, cx, cy, isolated };
  });

  const labels: Array<{ key: string; x: number; y: number; w: number; text: string; anchor: 'middle' | 'start'; color: string; size: number }> = [];
  // 三连位都放不下的标签 → 左侧引线队列(密集角落的标准制图手法)
  const overflow: Array<{ p: (typeof points)[number]; cx: number; cy: number; r: number; color: string }> = [];

  for (const { p, r, cx, cy, isolated } of bubbles) {
    const w = Math.min(textW(p.name, 10) + 8, 150);
    const h = 13;
    const color = colorOf(p);
    // 贴轴点(y=0)横排标签必然叠字(实测零食 6 家贴轴):一律进左侧引线栏
    if (p.y > 0.001 && isolated && r >= 11 && textW(p.name, 9.5) <= r * 1.7) {
      placed.push({ x: cx - w / 2, y: cy - h / 2, w, h });
      labels.push({ key: p.name, x: cx, y: cy + 3.3, w, text: p.name, anchor: 'middle', color: '#ffffff', size: 9.5 });
      continue;
    }
    if (p.y > 0.001) {
      const hit = (lx: number, ly: number) =>
        lx < m.l || lx + w > W - m.r || placed.some((b) => lx < b.x + b.w && lx + w > b.x && ly < b.y + b.h && ly + h > b.y);
      const cands: Array<[number, number]> = [
        [cx + r + 4, cy - 7],
        [cx - r - 4 - w, cy - 7],
        [Math.max(m.l, cx - w / 2), cy - r - h - 2],
      ];
      const spot = cands.find(([lx, ly]) => !hit(lx, ly));
      if (spot) {
        const [lx, ly] = spot;
        placed.push({ x: lx, y: ly, w, h });
        labels.push({ key: p.name, x: lx, y: ly + 9.5, w, text: p.name, anchor: 'start', color: color === GRAY ? '#64748b' : color, size: 10 });
        continue;
      }
    }
    overflow.push({ p, cx, cy, r, color });
  }

  // 引线队列:绘图区左缘栈排,细线指向气泡;按 x 升序(离原点近者靠下,引线不交叉)
  let scatterLeaders: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  if (overflow.length > 0) {
    overflow.sort((a, b) => a.cx - b.cx);
    let sy = Math.max(m.t + 4, Y(0) - 16 - overflow.length * 14);
    const leaders: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const o of overflow) {
      const w = Math.min(textW(o.p.name, 10) + 8, 150);
      const lx = m.l + 2;
      labels.push({ key: `ov-${o.p.name}`, x: lx, y: sy + 10, w, text: o.p.name, anchor: 'start', color: o.color === GRAY ? '#64748b' : o.color, size: 10 });
      leaders.push({ x1: o.cx - o.r * 0.7, y1: o.cy - o.r * 0.7, x2: lx + w - 2, y2: sy + 6 });
      sy += 14;
    }
    scatterLeaders = leaders;
  }

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
        {scatterLeaders.map((l, i) => (
          <line key={`ld-${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#cbd5e1" strokeWidth={0.8} />
        ))}
        {labels.map((l, i) => (
          <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={l.size} fontWeight={600} fill={l.color}>
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

/* ===== 可见度来源桑基(左=品牌命中量,右=问题层;带宽=命中次数) ===== */

function SankeyChart({ left, right, links, onDrill }: Extract<InsightBlock, { type: 'sankey' }> & { onDrill?: (d: InsightDrill) => void }) {
  const W = 680;
  const nodeW = 10;
  const xL = 132; // 左节点条 x
  const xR = W - 122 - nodeW; // 右节点条 x
  const gap = 12;
  const padT = 10;
  // 高度按节点数伸缩;两侧共享同一 px/单位 比例,丝带宽度才不失真
  const H = Math.max(190, Math.min(340, (left.length + right.length) * 30));
  const sum = (arr: Array<{ value: number }>) => arr.reduce((a, n) => a + n.value, 0);
  const scale = Math.min(
    (H - (left.length - 1) * gap) / Math.max(sum(left), 1),
    (H - (right.length - 1) * gap) / Math.max(sum(right), 1),
  );

  // 左右列纵向堆叠节点条
  const leftNode = new Map<number, { y: number; h: number }>();
  const rightNode = new Map<number, { y: number; h: number }>();
  let cur = 0;
  left.forEach((n, i) => {
    leftNode.set(i, { y: cur, h: Math.max(n.value * scale, 1) });
    cur += n.value * scale + gap;
  });
  cur = 0;
  right.forEach((n, i) => {
    rightNode.set(i, { y: cur, h: Math.max(n.value * scale, 1) });
    cur += n.value * scale + gap;
  });

  // 丝带:左侧按(from,to)顺序消耗节点内区段,右侧按(to,from)顺序——两侧都不交叉
  const segs = links.map((l, i) => ({ i, ...l, ly: 0, ry: 0 }));
  let cursorL = new Map<number, number>();
  for (const s of [...segs].sort((a, b) => a.from - b.from || a.to - b.to)) {
    s.ly = cursorL.get(s.from) ?? 0;
    cursorL.set(s.from, s.ly + s.value * scale);
  }
  cursorL = new Map();
  for (const s of [...segs].sort((a, b) => a.to - b.to || a.from - b.from)) {
    s.ry = cursorL.get(s.to) ?? 0;
    cursorL.set(s.to, s.ry + s.value * scale);
  }

  const ribbon = (y0: number, h: number, y1: number) => {
    const cx = (xL + nodeW + xR) / 2;
    return `M${xL + nodeW},${y0} C${cx},${y0} ${cx},${y1} ${xR},${y1} L${xR},${y1 + h} C${cx},${y1 + h} ${cx},${y0 + h} ${xL + nodeW},${y0 + h} Z`;
  };

  // 标签防重叠:节点过密时先下推再回推,保持 13px 行距
  const spread = (ys: number[]): number[] => {
    const out = [...ys];
    for (let i = 1; i < out.length; i++) if (out[i]! - out[i - 1]! < 13) out[i] = out[i - 1]! + 13;
    const over = out[out.length - 1]! - (H - 3);
    if (over > 0) for (let i = 0; i < out.length; i++) out[i]! -= over;
    for (let i = out.length - 1; i > 0; i--) if (out[i]! - out[i - 1]! < 13) out[i - 1] = out[i]! - 13;
    return out;
  };
  const leftYs = spread(left.map((_, i) => leftNode.get(i)!.y + leftNode.get(i)!.h / 2));
  const rightYs = spread(right.map((_, i) => rightNode.get(i)!.y + rightNode.get(i)!.h / 2));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + padT * 2}`} role="img" className="mx-auto max-w-[680px]">
      <g transform={`translate(0 ${padT})`}>
        {/* 丝带(品牌色低透明度,流量感) */}
        {segs.map((s) => {
          const ln = leftNode.get(s.from)!;
          const color = s.from >= 0 ? nameColor(left[s.from]!.name) : NAVY;
          return (
            <path
              key={s.i}
              d={ribbon(ln.y + s.ly, Math.max(s.value * scale, 0.6), rightNode.get(s.to)!.y + s.ry)}
              fill={color}
              fillOpacity={0.22}
            />
          );
        })}
        {/* 节点条:左=品牌色(跨图同色),右=藏青 */}
        {left.map((n, i) => {
          const p = leftNode.get(i)!;
          return (
            <g key={`l-${n.name}`} className={onDrill ? 'cursor-pointer' : undefined} onClick={onDrill ? () => onDrill({ kind: 'mentions', subject: n.name }) : undefined}>
              <rect x={xL} y={p.y} width={nodeW} height={p.h} rx={2} fill={nameColor(n.name)} />
              <text x={xL - 8} y={leftYs[i]! - 1} textAnchor="end" fontSize={11.5} fontWeight={600} fill="#1e293b" textDecoration={onDrill ? 'underline' : undefined}>
                {n.name}
              </text>
              <text x={xL - 8} y={leftYs[i]! + 10} textAnchor="end" fontSize={9.5} fill="#94a3b8">
                {n.value} 次
              </text>
            </g>
          );
        })}
        {right.map((n, i) => {
          const p = rightNode.get(i)!;
          return (
            <g key={`r-${n.name}`} className={onDrill ? 'cursor-pointer' : undefined} onClick={onDrill ? () => onDrill({ kind: 'mentions', layer: n.name }) : undefined}>
              <rect x={xR} y={p.y} width={nodeW} height={p.h} rx={2} fill={NAVY} />
              <text x={xR + nodeW + 8} y={rightYs[i]! - 1} fontSize={11.5} fontWeight={600} fill="#1e293b" textDecoration={onDrill ? 'underline' : undefined}>
                {n.name}
              </text>
              <text x={xR + nodeW + 8} y={rightYs[i]! + 10} fontSize={9.5} fill="#94a3b8">
                {n.value} 次{n.questions != null ? ` · ${n.questions} 题` : ''}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}


