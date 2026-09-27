'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState, Skeleton } from '@/components/ui';

interface Dist { value: string; count: number }
interface DistributionDto {
  ready: number; pending: number;
  gender: Dist[]; ageBand: Dist[]; cityTier: Dist[]; incomeBand: Dist[]; occupationGroup: Dist[];
}
const DIMENSIONS: Array<{ key: keyof DistributionDto & string; label: string }> = [
  { key: 'gender', label: '性别' },
  { key: 'ageBand', label: '年龄段' },
  { key: 'cityTier', label: '城市层级' },
  { key: 'incomeBand', label: '收入档' },
  { key: 'occupationGroup', label: '职业大类' },
];

/** 人口地图:全库结构化人物在五个维度上的分布(离线增强进度实时反映)。 */
export function PersonaMap() {
  const data = useQuery({
    queryKey: ['persona-distribution'],
    queryFn: () => api<DistributionDto>('/persona-library/distribution'),
    refetchInterval: query => query.state.data?.pending ? 8000 : false,
  });
  if (data.isPending) return <Skeleton />;
  if (data.error) return <p className="text-sm text-bad-600">{(data.error as Error).message}</p>;
  const d = data.data;
  if (!d.ready) return <EmptyState title="还没有可统计的人物" text="离线批量增强完成后,这里会呈现全库的性别、年龄、城市、收入与职业分布。" />;
  return <div className="space-y-5">
    <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-600">
      当前已增强 <strong className="metric-num text-sm text-slate-800">{d.ready}</strong> 位人物{d.pending > 0 ? `,离线增强还在进行中(队列 ${d.pending} 条),分布会持续变化` : ''}。人口属性来自源描述提取,未提及的归入「未知」——是档案的真实边界,不是数据缺失。
    </p>
    <div className="grid gap-4 lg:grid-cols-2">
      {DIMENSIONS.map(({ key, label }) => {
        const dist = d[key] as Dist[];
        const max = dist[0]?.count ?? 1;
        return <section key={key} className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">{label}分布</h3>
          <div className="space-y-2">
            {dist.slice(0, 10).map(({ value, count }) => (
              <div key={value} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate text-slate-600" title={value}>{value}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, count / max * 100)}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums text-slate-500">{(count / d.ready * 100).toFixed(1)}%</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-slate-400">{count}</span>
              </div>
            ))}
          </div>
          {dist.length > 10 && <p className="mt-2 text-[11px] text-slate-400">其余 {dist.length - 10} 个取值合计 {dist.slice(10).reduce((s, x) => s + x.count, 0)} 人</p>}
        </section>;
      })}
    </div>
  </div>;
}
