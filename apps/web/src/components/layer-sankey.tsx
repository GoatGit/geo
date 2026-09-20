'use client';

import { nameColor } from '@/components/insight-charts';

interface Row {
  layer: string;
  asked: number;
  mentioned: number;
  top3: number;
  top1: number;
  missed: number;
}

/**
 * 问题层→转化结局 桑基(品牌洞察,单品牌视角):
 * 左列=问题语义层(提问量),右列=四种结局(被首推/进Top3/仅提及/缺席);
 * 带宽=次数。回答「AI 在什么语境下推我」——行业版看谁有名,这里看推荐质量。
 * 布局与行业版 SankeyChart 同构(贝塞尔丝带 + 双侧共享比例尺)。
 */
export function LayerSankey({ rows }: { rows: Row[] }) {
  const W = 680;
  const nodeW = 10;
  const xL = 132;
  const xR = W - 148 - nodeW;
  const gap = 12;
  const padT = 10;
  const H = Math.max(180, Math.min(320, (rows.length + 4) * 28));

  // 右列四种结局按转化深度排序(首推最强)
  const OUT = ['被首推', '进 Top3(未首推)', '仅提及', '缺席'] as const;
  const rightVals = [
    rows.reduce((a, r) => a + r.top1, 0),
    rows.reduce((a, r) => a + (r.top3 - r.top1), 0),
    rows.reduce((a, r) => a + (r.mentioned - r.top3), 0),
    rows.reduce((a, r) => a + r.missed, 0),
  ];
  const totalLeft = rows.reduce((a, r) => a + r.asked, 0);
  const totalRight = rightVals.reduce((a, b) => a + b, 0);
  if (totalLeft === 0 || totalRight === 0) return null;
  const scale = Math.min(
    (H - (rows.length - 1) * gap) / totalLeft,
    (H - (OUT.length - 1) * gap) / totalRight,
  );

  let cur = 0;
  const leftNode = rows.map((r) => {
    const n = { y: cur, h: Math.max(r.asked * scale, 1) };
    cur += r.asked * scale + gap;
    return n;
  });
  cur = 0;
  const rightNode = rightVals.map((v) => {
    const n = { y: cur, h: Math.max(v * scale, 1) };
    cur += v * scale + gap;
    return n;
  });

  // 丝带:层 → 结局。左列按层序消耗,右列按「首推→缺席」深度序消耗
  const ribbons: Array<{ from: number; to: number; y0: number; h: number; y1: number }> = [];
  const rightCursor = new Map<number, number>();
  rows.forEach((r, fi) => {
    let ly = leftNode[fi]!.y;
    // 每层内部也按深度序出带:首推→Top3→仅提及→缺席
    const parts: Array<[number, number]> = [
      [0, r.top1],
      [1, Math.max(r.top3 - r.top1, 0)],
      [2, Math.max(r.mentioned - r.top3, 0)],
      [3, r.missed],
    ];
    for (const [ti, v] of parts) {
      if (v <= 0) continue;
      const ry = rightNode[ti]!.y + (rightCursor.get(ti) ?? 0);
      rightCursor.set(ti, (rightCursor.get(ti) ?? 0) + v * scale);
      ribbons.push({ from: fi, to: ti, y0: ly, h: Math.max(v * scale, 0.6), y1: ry });
      ly += v * scale;
    }
  });

  const OUT_COLORS = ['#15803d', '#1d3fae', '#6f7c8d', '#b6bdc9'];
  const ribbon = (y0: number, h: number, y1: number) => {
    const cx = (xL + nodeW + xR) / 2;
    return `M${xL + nodeW},${y0} C${cx},${y0} ${cx},${y1} ${xR},${y1} L${xR},${y1 + h} C${cx},${y1 + h} ${cx},${y0 + h} ${xL + nodeW},${y0 + h} Z`;
  };
  // 标签防重叠推挤(与行业版同法)
  const spread = (ys: number[]): number[] => {
    const out = [...ys];
    for (let i = 1; i < out.length; i++) if (out[i]! - out[i - 1]! < 13) out[i] = out[i - 1]! + 13;
    const over = out[out.length - 1]! - (H - 3);
    if (over > 0) for (let i = 0; i < out.length; i++) out[i]! -= over;
    for (let i = out.length - 1; i > 0; i--) if (out[i]! - out[i - 1]! < 13) out[i - 1] = out[i]! - 13;
    return out;
  };
  const leftYs = spread(leftNode.map((n) => n.y + n.h / 2));
  const rightYs = spread(rightNode.map((n) => n.y + n.h / 2));

  return (
    <section className="card rise p-6">
      <h2 className="text-sm font-semibold text-slate-900">问题层 → 转化结局</h2>
      <p className="mt-1 text-xs text-slate-500">
        左侧为问题语义层(带宽=提问量),右侧为 AI 给出的结局(带宽=次数):被首推最强,缺席最弱。
        看的是「AI 在什么语境下推你」,比率视角见指标卡与矩阵。
      </p>
      <svg width="100%" viewBox={`0 0 ${W} ${H + padT * 2}`} role="img" className="mx-auto mt-3 max-w-[680px]">
        <g transform={`translate(0 ${padT})`}>
          {ribbons.map((rb, i) => (
            <path key={i} d={ribbon(rb.y0, rb.h, rb.y1)} fill={OUT_COLORS[rb.to]} fillOpacity={0.26} />
          ))}
          {rows.map((r, i) => {
            const p = leftNode[i]!;
            return (
              <g key={r.layer}>
                <rect x={xL} y={p.y} width={nodeW} height={p.h} rx={2} fill={nameColor(r.layer)} />
                <text x={xL - 8} y={leftYs[i]! - 1} textAnchor="end" fontSize={11.5} fontWeight={600} fill="#1e293b">
                  {r.layer}
                </text>
                <text x={xL - 8} y={leftYs[i]! + 10} textAnchor="end" fontSize={9.5} fill="#94a3b8">
                  {r.asked} 问
                </text>
              </g>
            );
          })}
          {OUT.map((name, i) => {
            const p = rightNode[i]!;
            return (
              <g key={name}>
                <rect x={xR} y={p.y} width={nodeW} height={p.h} rx={2} fill={OUT_COLORS[i]} />
                <text x={xR + nodeW + 8} y={rightYs[i]! - 1} fontSize={11.5} fontWeight={600} fill="#1e293b">
                  {name}
                </text>
                <text x={xR + nodeW + 8} y={rightYs[i]! + 10} fontSize={9.5} fill="#94a3b8">
                  {rightVals[i]} 次
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}
