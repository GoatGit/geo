'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, PageHeader, Skeleton } from '@/components/ui';

interface OverviewDto {
  infra: {
    dbOk: boolean;
    redisOk: boolean;
    worker: { online: boolean; lastBeatAt: string | null; concurrency: number | null };
  };
  queueCounts: Array<{ name: string; waiting?: number; active?: number; delayed?: number; failed?: number; completed?: number }>;
  stats: Record<string, number>;
  todayRuns: Record<string, number>;
  accountPool: Array<{ status: string; count: number }>;
  engineHealth: Array<{ engine: string; ok: number; failed: number; total: number; successRate: number | null; tripped: boolean; manuallyPaused: boolean }>;
  recentRuns: Array<{ status: string; engine: string; ranAt: string; brandName: string }>;
  settings: { schedulerEnabled: boolean; globalDailyRunCap: number };
  asOf: string;
}

const QUEUE_LABELS: Record<string, string> = {
  collect: '采集',
  'extract-reputation': '口碑抽取',
  reports: '报告生成',
};

const STATUS_LABELS: Array<{ key: string; label: string; cls: string }> = [
  { key: 'ok_with_answer', label: '有回答', cls: 'text-good' },
  { key: 'ok_empty', label: '空回答', cls: 'text-slate-500' },
  { key: 'failed', label: '失败', cls: 'text-bad' },
  { key: 'quota_blocked', label: '配额拦截', cls: 'text-warn' },
];

/** 平台后台 · 系统总览:基础设施 / 队列 / 今日任务 / 引擎通道(含手动熔断管控)。 */
export default function AdminOverviewPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<OverviewDto>('/admin/overview'),
    refetchInterval: 10_000,
  });

  if (isLoading || !data) return <Skeleton />;

  const stats = data.stats ?? {};
  const worker = data.infra.worker;

  const toggleEngine = async (engine: string, paused: boolean) => {
    await api(`/admin/engines/${engine}/${paused ? 'resume' : 'pause'}`, { method: 'POST' });
    void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
  };

  return (
    <>
      <PageHeader
        title="系统总览"
        desc={
          <span className="flex flex-wrap items-center gap-2">
            <span>平台运行状态 · 数据时间 {new Date(data.asOf).toLocaleTimeString('zh-CN')}</span>
            {data.settings.schedulerEnabled ? (
              <Badge label="调度中" tone="good" />
            ) : (
              <Badge label="调度已停用" tone="bad" />
            )}
          </span>
        }
      />

      {/* 基础设施 */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HealthCard title="API 服务" ok desc="本页可访问即在线" />
        <HealthCard title="PostgreSQL" ok={data.infra.dbOk} desc="业务库" />
        <HealthCard title="Redis" ok={data.infra.redisOk} desc="队列 / 熔断 / 进度" />
        <HealthCard
          title="采集 Worker"
          ok={worker.online}
          desc={
            worker.online
              ? `并发 ${worker.concurrency ?? '—'} · 心跳 ${worker.lastBeatAt ? new Date(worker.lastBeatAt).toLocaleTimeString('zh-CN') : '—'}`
              : '心跳超时,请检查 worker 实例'
          }
        />
      </section>

      {/* 今日任务 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card rise-1 p-6">
          <h2 className="mb-4 font-semibold text-slate-900">今日任务</h2>
          <div className="mb-4">
            <span className="metric-num text-3xl font-semibold text-slate-900">{stats.runs_today ?? 0}</span>
            <span className="ml-2 text-xs text-slate-400">QueryRun(自然日)</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {STATUS_LABELS.map((s) => (
              <div key={s.key} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className={`metric-num text-lg font-semibold ${s.cls}`}>{data.todayRuns[s.key] ?? 0}</p>
                <p className="text-[11px] text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            全局每日上限:{data.settings.globalDailyRunCap > 0 ? `${data.settings.globalDailyRunCap} 条` : '不限'}(全局配置页可调)
          </p>
        </div>

        <div className="card p-6">
          <h2 className="mb-4 font-semibold text-slate-900">队列深度</h2>
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="py-1">队列</th>
                <th className="py-1">等待</th>
                <th className="py-1">执行中</th>
                <th className="py-1">延迟重排</th>
                <th className="py-1">失败</th>
              </tr>
            </thead>
            <tbody>
              {data.queueCounts.map((q) => (
                <tr key={q.name} className="border-t">
                  <td className="py-1.5">{QUEUE_LABELS[q.name] ?? q.name}</td>
                  <td className="metric-num py-1.5">{q.waiting ?? 0}</td>
                  <td className="metric-num py-1.5">{q.active ?? 0}</td>
                  <td className="metric-num py-1.5">{q.delayed ?? 0}</td>
                  <td className={`metric-num py-1.5 ${(q.failed ?? 0) > 0 ? 'text-bad' : ''}`}>{q.failed ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {(data.accountPool ?? []).map((p) => (
              <Badge key={p.status} label={`账号池 ${p.status} ${p.count}`} tone={p.status === 'available' ? 'good' : 'warn'} />
            ))}
            {(data.accountPool ?? []).length === 0 && <span className="text-xs text-slate-400">账号池为空</span>}
          </div>
        </div>
      </section>

      {/* 引擎通道 */}
      <section className="card rise-2 p-6">
        <h2 className="mb-4 font-semibold text-slate-900">引擎通道(近 24 小时)</h2>
        <table className="w-full text-xs">
          <thead className="text-left text-slate-400">
            <tr>
              <th className="py-1">引擎</th>
              <th className="py-1">24h 任务</th>
              <th className="py-1">成功率</th>
              <th className="py-1">状态</th>
              <th className="py-1 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.engineHealth.map((e) => {
              const paused = e.manuallyPaused;
              return (
                <tr key={e.engine} className="border-t">
                  <td className="py-1.5">{e.engine}</td>
                  <td className="metric-num py-1.5">
                    {e.ok}✓ / {e.failed}✗
                  </td>
                  <td className="metric-num py-1.5">{e.successRate == null ? '—' : `${Math.round(e.successRate * 100)}%`}</td>
                  <td className="py-1.5">
                    {paused ? (
                      <Badge label="手动暂停" tone="bad" />
                    ) : e.tripped ? (
                      <Badge label="自动熔断" tone="warn" />
                    ) : (
                      <Badge label="正常" tone="good" />
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => void toggleEngine(e.engine, paused)}
                      disabled={!paused && !data.infra.redisOk}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                        paused
                          ? 'bg-emerald-50 text-good hover:bg-emerald-100'
                          : 'bg-red-50 text-bad hover:bg-red-100'
                      } disabled:opacity-40`}
                    >
                      {paused ? '恢复派发' : '暂停派发'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-slate-400">
          自动熔断 5 分钟半开重试;手动暂停无过期,恢复前该引擎不派发。暂停期间任务延迟重排,不产生 failed 污染口径。
        </p>
      </section>

      {/* 最近任务 */}
      <section className="card p-6">
        <h2 className="mb-3 font-semibold text-slate-900">最近任务(全平台)</h2>
        <div className="flex flex-wrap gap-1.5">
          {data.recentRuns.slice(0, 60).map((r, i) => (
            <span
              key={i}
              title={`${r.brandName} · ${r.engine} · ${r.status} · ${new Date(r.ranAt).toLocaleTimeString('zh-CN')}`}
              className={`h-2.5 w-2.5 rounded-sm ${
                r.status === 'ok_with_answer'
                  ? 'bg-emerald-400'
                  : r.status === 'ok_empty'
                    ? 'bg-slate-300'
                    : r.status === 'failed'
                      ? 'bg-red-400'
                      : 'bg-amber-300'
              }`}
            />
          ))}
          {data.recentRuns.length === 0 && <span className="text-sm text-slate-400">暂无任务</span>}
        </div>
        <p className="mt-2 text-[10px] text-slate-400">
          绿=有回答 · 灰=空回答 · 红=失败 · 黄=配额拦截;悬停查看品牌与引擎。
        </p>
      </section>
    </>
  );
}

function HealthCard({ title, ok, desc }: { title: string; ok?: boolean; desc: string }) {
  return (
    <div className="card rise p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
      </div>
      <p className={`mt-2 text-lg font-semibold ${ok ? 'text-good' : 'text-bad'}`}>{ok ? '正常' : '异常'}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{desc}</p>
    </div>
  );
}
