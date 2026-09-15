'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MetricCardView } from '@/components/metric-card';
import { Badge, EmptyState, PageHeader, Skeleton, pct } from '@/components/ui';
import { IconArrowRight, IconCheck, IconList, IconLogo, IconPulse, IconShield } from '@/components/icons';
import { api, useBrandId, useRankings } from '@/lib/queries';
import type { InsightSummaryDto } from '@geo/shared';

const HEALTH_LABELS: Record<string, string> = {
  mentionRate: '提及率',
  top3Rate: 'Top3 率',
  top1Rate: '首推率',
  avgRank: '平均名次',
  sentimentScore: '情绪得分',
  ownedCitationShare: '自有信源占比',
};

const PRIORITY_TONE: Record<string, string> = {
  P0: 'bg-bad-50 text-bad',
  P1: 'bg-warn-50 text-warn',
  P2: 'bg-slate-100 text-slate-500',
};

interface QuotaDto {
  plan: string;
  ranking: { used: number; limit: number };
  reputation: { used: number; limit: number };
}
interface StatusDto {
  rounds: Array<{ id: number; startedAt: string; finishedAt: string | null; totals: { total?: number; done?: number; ok?: number; failed?: number } | null }>;
}
interface ActionsDto {
  rulesetVersion: string;
  items: Array<{ priority: 'P0' | 'P1' | 'P2'; ruleId: string; action: string; dataBasis: string; target: string }>;
}

/** 总览(docs/01 ①):驾驶舱——指标 + 体检 + 行动清单 + 采集动态;无数据时给引导清单。 */
export default function DashboardPage() {
  const brandId = useBrandId();
  const rankings = useRankings(1);
  const quota = useQuery({
    queryKey: ['quota', brandId],
    queryFn: () => api<QuotaDto>(`/brands/${brandId}/quota`),
    enabled: !!brandId,
  });
  const status = useQuery({
    queryKey: ['collection', brandId],
    queryFn: () => api<StatusDto>(`/collection/status?brand=${brandId}`),
    enabled: !!brandId,
  });
  const actions = useQuery({
    queryKey: ['actions', brandId],
    queryFn: () => api<ActionsDto>(`/monitor/actions?brand=${brandId}&days=7`),
    enabled: !!brandId,
  });
  // 识别口径核对完成 = 所有条目(含 AI 建议竞品)均已确认
  // (hooks 必须在条件 return 之前调用)
  const recognition = useQuery({
    queryKey: ['recognition-dash', brandId],
    queryFn: () => api<{ id: number; confirmed: boolean }[]>(`/brands/${brandId}/recognition`),
    enabled: !!brandId,
  });

  if (rankings.isLoading) return <Skeleton />;
  if (rankings.error) {
    return <EmptyState text={`数据加载失败:${rankings.error.message}(可在顶栏切换品牌后重试)`} />;
  }
  if (!rankings.data) return <Skeleton />;
  const data = rankings.data;
  const hasData = (data.cards.find((c) => c.metric === 'mentionRate')?.denominator ?? 0) > 0;
  const questionsConfigured =
    (quota.data?.ranking.used ?? 0) + (quota.data?.reputation.used ?? 0) > 0;
  const hasRound = (status.data?.rounds.length ?? 0) > 0;
  const recognitionConfirmed =
    (recognition.data?.length ?? 0) > 0 && (recognition.data ?? []).every((r) => r.confirmed);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <>
            总览
            <Badge label={data.source === 'realtime' ? '实时' : '日结'} tone="brand" />
          </>
        }
        actions={
          <Link href="/monitor/rankings" className="btn-ghost">
            查看排名透视
            <IconArrowRight width={14} height={14} />
          </Link>
        }
      />

      {/* 引导清单(无数据时) */}
      {!hasData && (
        <div className="card rise relative overflow-hidden p-6">
          <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-400 to-sand-400" />
          <h2 className="mb-1 font-semibold text-slate-900">完成以下 4 步,点亮你的品牌可见性</h2>
          <p className="mb-5 text-sm text-slate-500">预计 10 分钟内看到首轮真实数据。</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Step done label="创建品牌工作区" desc="AI 已解析品牌档案与识别口径建议" />
            <Step
              done={questionsConfigured}
              label="添加监控问题"
              desc="排名词 + 口碑词,分池配额"
              href="/config/questions"
              icon={<IconList width={15} height={15} />}
            />
            <Step
              done={hasRound}
              label="等待首轮采集完成"
              desc="5 大引擎逐条出数,进度见采集状态"
              href="/config/collection"
              icon={<IconPulse width={15} height={15} />}
            />
            <Step
              done={recognitionConfirmed}
              label="核对本品识别口径"
              desc="登记产品线别名,避免自家产品被误判为竞品"
              href="/config/recognition"
              icon={<IconShield width={15} height={15} />}
            />
          </div>
        </div>
      )}

      {/* 行业洞察(已发布报告;docs/01 §3.10 扩展板块) */}
      <InsightSection />

      {/* 指标卡 */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(['mentionRate', 'top3Rate', 'top1Rate', 'avgRank'] as const).map((m, i) => (
          <div key={m} className={`rise-${i + 1}`}>
            <MetricCardView
              title={{ mentionRate: '提及率', top3Rate: 'Top3 率', top1Rate: '首推率', avgRank: '平均名次' }[m]}
              card={data.cards.find((c) => c.metric === m)}
              lowerBetter={m === 'avgRank'}
              spark={
                m === 'avgRank'
                  ? undefined
                  : data.trend.map((t) => (m === 'mentionRate' ? t.mentionRate : m === 'top3Rate' ? t.top3Rate : t.top1Rate))
              }
              sparkLabel="趋势"
            />
          </div>
        ))}
      </section>

      {hasData && (
        <section className="grid gap-4 lg:grid-cols-2">
          {/* 品牌体检 */}
          <div className="card rise-2 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">品牌体检</h2>
              <span className="text-sm text-slate-500">{data.health.summary}</span>
            </div>
            <div className="space-y-3">
              {data.health.items.map((item) => (
                <div key={item.metric}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">{HEALTH_LABELS[item.metric] ?? item.metric}</span>
                    <span className="flex items-center gap-2">
                      <span className="metric-num text-slate-700">
                        {item.value == null ? '—' : item.metric === 'avgRank' ? item.value : pct(item.value)}
                      </span>
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                          item.pass === null
                            ? 'bg-slate-100 text-slate-400'
                            : item.pass
                              ? 'bg-good-50 text-good'
                              : 'bg-warn-50 text-warn'
                        }`}
                      >
                        {item.pass === null ? '暂无数据' : item.pass ? '达标' : item.label}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100">
                    <div
                      className={`h-1.5 animate-grow-w rounded-full ${
                        item.pass === null ? 'bg-slate-200' : item.pass ? 'bg-good' : 'bg-warn'
                      }`}
                      style={{
                        width: item.value == null ? '0%' : item.metric === 'avgRank' ? '100%' : `${Math.min(100, item.value * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {data.excluded.failed + data.excluded.quotaBlocked > 0 && (
              <p className="mt-4 rounded-lg bg-warn-50 px-3.5 py-2.5 text-xs leading-5 text-warn">
                近 24h 有 <b className="metric-num">{data.excluded.failed}</b> 次失败、
                <b className="metric-num"> {data.excluded.quotaBlocked}</b> 次配额拦截(不计入分母)——
                <Link href="/config/collection" className="underline underline-offset-2">
                  详情
                </Link>
              </p>
            )}
          </div>

          {/* 行动清单 */}
          <div className="card rise-3 flex flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">行动清单</h2>
              <span className="text-[10px] text-slate-400">规则集 {actions.data?.rulesetVersion ?? '—'}</span>
            </div>
            <div className="flex-1 space-y-2.5">
              {(actions.data?.items ?? []).slice(0, 4).map((item) => (
                <div key={item.ruleId + item.action} className="rounded-lg border border-slate-100 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50/30">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${PRIORITY_TONE[item.priority]}`}>
                      {item.priority}
                    </span>
                    <span className="text-xs text-slate-400">{item.dataBasis}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-5 text-slate-700">{item.action}</p>
                </div>
              ))}
              {(actions.data?.items ?? []).length === 0 && (
                <p className="text-sm text-slate-400">暂无行动建议:指标达标或数据尚不足。</p>
              )}
            </div>
            <p className="mt-3 text-[10px] text-slate-400">
              由确定性规则引擎生成,规则版本入库可复现(docs/02 §6)。
            </p>
          </div>
        </section>
      )}

      {/* 采集动态 */}
      {hasData && (
        <div className="card rise p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">采集动态</h2>
            <Link href="/config/collection" className="flex items-center gap-1 text-xs text-brand-600 hover:underline">
              采集状态
              <IconArrowRight width={12} height={12} />
            </Link>
          </div>
          <div className="space-y-2.5">
            {(status.data?.rounds ?? []).filter((r) => (r.totals?.total ?? 0) > 0).slice(0, 3).map((r) => {
              const t = r.totals ?? {};
              const done = t.done ?? 0;
              const total = t.total ?? 0;
              return (
                <div key={r.id} className="flex items-center gap-3 text-xs">
                  <span className="w-16 text-slate-500">轮次 #{r.id}</span>
                  <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                    <div
                      className="h-1.5 animate-grow-w rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                      style={{ width: total ? `${(done / total) * 100}%` : 0 }}
                    />
                  </div>
                  <span className="metric-num w-16 text-right text-slate-500">
                    {done}/{total}
                  </span>
                  <span className="w-14 text-right">
                    {r.finishedAt ? (
                      <span className="text-good">已完成</span>
                    ) : (
                      <span className="animate-pulse-soft text-brand-600">进行中</span>
                    )}
                  </span>
                  <span className="w-32 text-right text-slate-400">
                    {new Date(r.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}
            {(status.data?.rounds.length ?? 0) === 0 && (
              <p className="text-sm text-slate-400">还没有采集轮次</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Step({
  done,
  label,
  desc,
  href,
  icon,
}: {
  done: boolean;
  label: string;
  desc: string;
  href?: string;
  icon?: React.ReactNode;
}) {
  const inner = (
    <div
      className={`flex h-full items-start gap-3 rounded-xl border p-4 transition-all duration-200 ${
        done ? 'border-good-100 bg-good-50/40' : 'border-slate-200 bg-white hover:border-brand-300 hover:shadow-card-hover'
      }`}
    >
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          done ? 'bg-good text-white' : 'bg-brand-50 text-brand-600'
        }`}
      >
        {done ? <IconCheck width={12} height={12} /> : icon ?? <IconLogo width={12} height={12} />}
      </span>
      <span>
        <span className={`block text-sm font-medium ${done ? 'text-good' : 'text-slate-800'}`}>
          {label}
          {done && ' · 已完成'}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{desc}</span>
      </span>
      {!done && href && (
        <IconArrowRight width={14} height={14} className="ml-auto mt-1 shrink-0 text-brand-400" />
      )}
    </div>
  );
  return href && !done ? (
    <Link href={href} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}


/** 行业洞察板块(docs/01 §3.10 扩展):已发布的行业报告卡片,点击进入印刷风详情页。 */
function InsightSection() {
  const insights = useQuery({
    queryKey: ['insights-published'],
    queryFn: () => api<InsightSummaryDto[]>('/insights'),
  });
  if (!insights.data || insights.data.length === 0) return null;
  return (
    <section className="card rise p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-slate-900">行业洞察</h2>
        <span className="text-[10px] text-slate-400">各行业在主流 AI 引擎中的可见度实测</span>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {insights.data.slice(0, 6).map((it) => (
          <Link
            key={it.id}
            href={`/insights/${it.id}`}
            className="group rounded-xl border border-slate-100 p-4 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover"
          >
            <p className="flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
              <Badge label={it.industry} tone="brand" />
              {it.issue && <span>{it.issue}</span>}
            </p>
            <h3 className="mt-2 text-[13px] font-semibold leading-5 text-slate-800 group-hover:text-brand-700">{it.title}</h3>
            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-slate-500">{it.summary}</p>
            {(it.cover.brands || it.cover.questions) && (
              <p className="metric-num mt-2 text-[10px] text-slate-400">
                {[it.cover.brands && `${it.cover.brands} 品牌`, it.cover.questions && `${it.cover.questions} 题`, it.cover.answers && `${it.cover.answers} 条回答`].filter(Boolean).join(' · ')}
              </p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
