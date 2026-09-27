'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui';

interface BenchCard { key: string; title: string; unit: string; rows: Array<{ value: string; share: number; note?: string }> }
interface DistributionDto { pending: number; benchmark: { source: string; dimensions: BenchCard[] } }

/** 人口地图:按权威公开数据(国家统计局公报/七普/通用城市分层)展示真实人口结构。 */
export function PersonaMap() {
  const data = useQuery({
    queryKey: ['persona-distribution'],
    queryFn: () => api<DistributionDto>('/persona-library/distribution'),
    refetchInterval: query => query.state.data?.pending ? 8000 : false,
  });
  if (data.isPending) return <Skeleton />;
  if (data.error) return <p className="text-sm text-bad-600">{(data.error as Error).message}</p>;
  const dimensions = data.data?.benchmark.dimensions ?? [];
  return <div className="grid gap-4 lg:grid-cols-2">
    {dimensions.map(card => <section key={card.key} className="card p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{card.title}</h3>
        <span className="text-[11px] text-slate-400">{card.unit}</span>
      </div>
      <div className="space-y-2.5">
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
      </div>
    </section>)}
  </div>;
}
