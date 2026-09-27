'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui';

interface BenchRow { value: string; share: number; note?: string; bar?: number }
interface DistributionDto {
  pending: number;
  source: string;
  benchmark: Record<string, { title: string; unit: string; rows: BenchRow[]; syntheticNote: string }>;
  synthetic: Record<string, Array<{ value: string; count: number; share?: number }>>;
}
const CARDS = ['gender', 'age', 'region', 'income', 'occupation'] as const;

/** 人口地图:按国家统计局权威公开数据展示真实人口结构;合成人群库分布作对照。 */
export function PersonaMap() {
  const data = useQuery({
    queryKey: ['persona-distribution'],
    queryFn: () => api<DistributionDto>('/persona-library/distribution'),
    refetchInterval: query => query.state.data?.pending ? 8000 : false,
  });
  if (data.isPending) return <Skeleton />;
  if (data.error) return <p className="text-sm text-bad-600">{(data.error as Error).message}</p>;
  const d = data.data;
  return <div className="space-y-5">
    <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-600">
      人口结构数据来源:{d.source}。这张图是<strong>真实人口参考地图</strong>——做人群配额决策时,先看目标人群在真实人口中的位置;下方灰字为合成人群库的对应分布,便于对照差距。增强离线跑批进行中(队列 {d.pending} 条)。
    </p>
    <div className="grid gap-4 lg:grid-cols-2">
      {CARDS.map(key => {
        const card = d.benchmark[key];
        return <section key={key} className="card p-5">
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
                  <div className="h-full rounded-full bg-ink-700" style={{ width: `${Math.max(2, (r.bar ?? r.share) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-slate-50 pt-2.5 text-[11px] leading-5 text-slate-400">{card.syntheticNote}</p>
        </section>;
      })}
    </div>
    <p className="text-xs leading-6 text-slate-400">合成人群库的人物由离线结构化生成,其人口属性只来自源描述明示的信息(未提及即「未知」),因此与真实人口分布存在差距属预期现象;需要代表性时,请使用配额抽样并参照上方权威基准。</p>
  </div>;
}
