'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui';

interface BenchCard { key: string; title: string; unit: string; rows: Array<{ value: string; share: number; note?: string; bar?: number; amount?: number }> }
interface PyramidBand { band: string; male: number; female: number }
interface DistributionDto {
  pending: number;
  benchmark: { source: string; dimensions: BenchCard[] };
  agePyramid: PyramidBand[];
}

/** 收入分布折线:横轴各组人均收入,纵轴累计人口占比(洛伦兹式)——线越陡的区间,人口越集中。 */
function IncomeLine({ rows }: { rows: Array<{ value: string; share: number; amount: number }> }) {
  const w = 560, h = 200, pl = 46, pr = 18, pt = 16, pb = 40;
  const n = rows.length;
  const x = (i: number) => pl + (i * (w - pl - pr)) / (n - 1);
  const y = (cum: number) => pt + (1 - cum) * (h - pt - pb);
  const points = rows.map((r, i) => ({ r, x: x(i), y: y((i + 1) / n) }));
  const line = points.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${pl},${y(0)} ${line} ${x(n - 1)},${y(0)}`;
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-52 w-full" role="img" aria-label="居民收入分布折线图">
    <defs>
      <linearGradient id="incomeArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#3e7c59" stopOpacity="0.28" />
        <stop offset="100%" stopColor="#3e7c59" stopOpacity="0.02" />
      </linearGradient>
    </defs>
    {[0, 20, 40, 60, 80, 100].map(v => (
      <g key={v}>
        <line x1={pl} x2={w - pr} y1={y(v / 100)} y2={y(v / 100)} stroke="#e2e8f0" strokeWidth="1" />
        <text x={pl - 6} y={y(v / 100) + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{v}%</text>
      </g>
    ))}
    <polygon points={area} fill="url(#incomeArea)" />
    <polyline points={line} fill="none" stroke="#3e7c59" strokeWidth="2.5" strokeLinejoin="round" />
    {points.map((p, i) => <g key={`d${i}`}>
      <circle cx={p.x} cy={p.y} r="3.5" fill="#3e7c59" stroke="#fff" strokeWidth="1.5" />
      <text x={p.x} y={p.y - 8} textAnchor="middle" fontSize="9.5" fill="#475569">{((i + 1) * 20)}%</text>
    </g>)}
    {points.map((p, i) => <g key={`x${i}`}>
      <text x={p.x} y={h - pb + 14} textAnchor="middle" fontSize="9.5" fill="#475569">{p.r.value.replace('组', '')}</text>
      <text x={p.x} y={h - pb + 27} textAnchor="middle" fontSize="9" fill="#94a3b8">{(p.r.amount / 10000).toFixed(1)} 万</text>
    </g>)}
    <text x={w - pr} y={h - 6} textAnchor="end" fontSize="9" fill="#94a3b8">横轴:各组人均收入 · 纵轴:累计人口占比</text>
  </svg>;
}

/** 人口地图:按权威公开数据(国家统计局公报/七普/通用城市分层)展示真实人口结构。 */
export function PersonaMap() {
  const data = useQuery({
    queryKey: ['persona-distribution'],
    queryFn: () => api<DistributionDto>('/persona-library/distribution'),
    refetchInterval: query => query.state.data?.pending ? 8000 : false,
  });
  if (data.isPending) return <Skeleton />;
  if (data.error) return <p className="text-sm text-bad-600">{(data.error as Error).message}</p>;
  const dimensions = (data.data?.benchmark.dimensions ?? []).filter(c => c.key !== 'age');
  const pyramid = data.data?.agePyramid ?? [];
  const maxBand = Math.max(...pyramid.map(p => Math.max(p.male, p.female)), 1);
  return <div className="space-y-5">
    <section className="card p-5 sm:p-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">人口金字塔(性别 × 年龄)</h3>
        <span className="text-[11px] text-slate-400">万人 · 七普,男左 女 右</span>
      </div>
      <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-ink-700" />男(左侧)</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-brand-500" />女(右侧)</span>
      </div>
      <div className="mt-3 space-y-[3px]">
        {pyramid.map(b => (
          <div key={b.band} className="grid grid-cols-[1fr_52px_1fr] items-center gap-1.5">
            <div className="flex justify-end"><div className="h-3.5 rounded-l-sm bg-ink-700" style={{ width: `${b.male / maxBand * 100}%` }} title={`男 ${b.male} 万`} /></div>
            <span className="text-center text-[10px] tabular-nums text-slate-400">{b.band}</span>
            <div className="flex justify-start"><div className="h-3.5 rounded-r-sm bg-brand-500" style={{ width: `${b.female / maxBand * 100}%` }} title={`女 ${b.female} 万`} /></div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-400">条长按各年龄组人口数;金字塔能同时看出年龄结构与性别结构。</p>
    </section>
    <div className="grid gap-4 lg:grid-cols-2">
      {dimensions.map(card => card.key === 'income'
        ? <section key={card.key} className="card p-5 lg:col-span-2">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">{card.title}</h3>
              <span className="text-[11px] text-slate-400">{card.unit}</span>
            </div>
            <IncomeLine rows={card.rows.map(r => ({ value: r.value, share: r.share, amount: r.amount ?? 0 }))} />
          </section>
        : <section key={card.key} className="card p-5">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{card.title}</h3>
          <span className="text-[11px] text-slate-400">{card.unit}</span>
        </div>
        {card.key === 'income'
          ? <IncomeLine rows={card.rows.map(r => ({ value: r.value, share: r.share, amount: r.amount ?? 0 }))} />
          : <div className="space-y-2.5">
              {card.rows.map(r => (
                <div key={r.value}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-slate-600">{r.value}</span>
                    <span className="shrink-0 tabular-nums"><strong className="text-sm font-semibold text-slate-800">{(r.share * 100).toFixed(1)}%</strong>{r.note && <span className="ml-2 text-slate-400">{r.note}</span>}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-ink-700" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>}
      </section>)}
    </div>
  </div>;
}
