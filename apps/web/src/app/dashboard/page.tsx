'use client';

import { MetricCardView } from '@/components/metric-card';
import { Badge, EmptyState, Skeleton, pct } from '@/components/ui';
import { useRankings } from '../../lib/queries';

/** 总览(docs/01 ①):品牌健康卡 + 今日关键指标 + 行动清单。 */
export default function DashboardPage() {
  const { data, isLoading, error } = useRankings(1);

  if (isLoading) return <Skeleton />;
  if (error || !data) return <EmptyState text="暂无数据:先在「监控问题」完成配置,首轮采集后此处点亮" />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">总览</h1>
        <p className="text-sm text-slate-500">
          数据截至 <span className="metric-num">{new Date(data.asOf).toLocaleString('zh-CN')}</span>
          <Badge label={data.source === 'realtime' ? '实时' : '日结'} />
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCardView title="提及率" card={data.cards.find((c) => c.metric === 'mentionRate')!} />
        <MetricCardView title="Top3 率" card={data.cards.find((c) => c.metric === 'top3Rate')!} />
        <MetricCardView title="首推率" card={data.cards.find((c) => c.metric === 'top1Rate')!} />
        <MetricCardView title="平均名次" card={data.cards.find((c) => c.metric === 'avgRank')!} lowerBetter />
      </section>

      <section className="rounded-lg border bg-white p-5">
        <h2 className="mb-2 font-medium">品牌体检</h2>
        <p className="mb-3 text-sm text-slate-600">{data.health.summary}</p>
        <div className="flex flex-wrap gap-2">
          {data.health.items.map((i) => (
            <span
              key={i.metric}
              className={`rounded-full px-2.5 py-1 text-xs ${
                i.pass === null
                  ? 'bg-slate-100 text-slate-500'
                  : i.pass
                    ? 'bg-emerald-50 text-good'
                    : 'bg-amber-50 text-warn'
              }`}
            >
              {i.metric} {i.pass === null ? '—' : i.pass ? '达标' : i.label}
              {i.value !== null && ` · ${typeof i.value === 'number' && i.metric !== 'avgRank' ? pct(i.value) : i.value}`}
            </span>
          ))}
        </div>
        {data.excluded.failed + data.excluded.quotaBlocked > 0 && (
          <p className="mt-3 text-xs text-warn">
            注意:近 24h 有 {data.excluded.failed} 次采集失败、{data.excluded.quotaBlocked} 次配额拦截
            (不计入指标分母,详见<a className="underline" href="/config/collection">采集状态</a>)。
          </p>
        )}
      </section>
    </div>
  );
}


