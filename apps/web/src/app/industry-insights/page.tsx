'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { InsightSummaryDto } from '@geo/shared';

interface MineIndustry {
  industryId: number;
  industry: string;
  /** 平台已配置监测品牌(未配置时生成按钮置灰,避免必然失败的提交) */
  configured: boolean;
  insight: {
    id: number;
    issue: string;
    title: string;
    summary: string;
    status: string;
    buildStatus: string;
    builtAt: string | null;
    windowDays: number | null;
    shareStatus: string;
    shareNote: string | null;
  } | null;
}

interface HubDto {
  mine: MineIndustry[];
  official: InsightSummaryDto[];
  /** 用户品牌存在、但行业洞察尚未开通的行业名 */
  unopened: string[];
  hasBrands: boolean;
}

const SHARE_META: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'slate' }> = {
  pending: { label: '审核中', tone: 'warn' },
  approved: { label: '已发布', tone: 'good' },
  rejected: { label: '已驳回', tone: 'bad' },
};

const BUILD_META: Record<string, { label: string; tone: 'brand' | 'warn' | 'slate' }> = {
  running: { label: '聚合中…', tone: 'warn' },
  failed: { label: '生成失败', tone: 'slate' },
};

/**
 * 行业洞察(一等公民产品页):我的行业洞察(生成/分享/审核态)+ 官方洞察流。
 * 用户对自己品牌所属行业可触发生成,分享后进入平台审核,通过即发布到官网首页。
 */
export default function IndustryInsightsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const hub = useQuery({ queryKey: ['insights-hub'], queryFn: () => api<HubDto>('/insights/hub'), refetchInterval: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<number | null>(null);
  const [shareNote, setShareNote] = useState('');

  const runBuild = useMutation({
    mutationFn: (industryId: number) =>
      api(`/insights/industries/${industryId}/run`, { method: 'POST', json: { windowDays: 30 } }),
    onSuccess: () => {
      toast('已开始聚合,约 1 分钟后刷新查看');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  const apply = useMutation({
    mutationFn: (industry: string) =>
      api(`/insights/industries/apply`, { method: 'POST', json: { industry } }),
    onSuccess: () => {
      toast('已申请开通,平台配置监测品牌后即可生成洞察');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  const share = useMutation({
    mutationFn: (id: number) => api(`/insights/${id}/share`, { method: 'POST', json: { note: shareNote || undefined } }),
    onSuccess: () => {
      toast('已提交分享,平台审核通过后将发布到官网首页');
      setShareTarget(null);
      setShareNote('');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  if (hub.isLoading) return <Skeleton />;
  const data = hub.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="行业洞察"
        desc="你所在行业的 AI 可见度全景:格局、信源与竞争声场;生成后可分享,平台审核通过即发布到官网"
      />

      {/* 我的行业洞察 */}
      <section>
        <h2 className="mb-3 font-semibold text-slate-900">我的行业</h2>
        {(data?.mine ?? []).length === 0 && (data?.unopened ?? []).length === 0 ? (
          data?.hasBrands ? (
            <EmptyState
              title="品牌行业暂未收录"
              text="你品牌的行业在平台行业库中暂未收录,请联系平台运营开通。"
            />
          ) : (
            <EmptyState
              title="还没有可洞察的行业"
              text="创建品牌后,系统会按品牌所在行业自动匹配;行业数据积累完成后即可生成行业洞察。"
              action={<Link href="/brands/new" className="btn-primary">创建品牌</Link>}
            />
          )
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {(data?.mine ?? []).map((m) => {
              const ins = m.insight;
              const shareBadge = ins && ins.status !== 'published' ? SHARE_META[ins.shareStatus] : ins ? SHARE_META.approved : undefined;
              const buildBadge = ins ? BUILD_META[ins.buildStatus] : undefined;
              return (
                <div key={m.industryId} className="card rise p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-slate-900">{m.industry}</h3>
                    <div className="flex items-center gap-1.5">
                      {buildBadge && <Badge label={buildBadge.label} tone={buildBadge.tone} />}
                      {shareBadge && <Badge label={shareBadge.label} tone={shareBadge.tone} />}
                    </div>
                  </div>
                  {ins ? (
                    <>
                      <p className="mt-2 line-clamp-1 text-sm font-medium text-slate-800">{ins.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{ins.summary}</p>
                      <p className="metric-num mt-2 text-[11px] text-slate-400">
                        {ins.issue || '第 1 期'}
                        {ins.builtAt ? ` · 生成于 ${new Date(ins.builtAt).toLocaleDateString('zh-CN')}` : ''}
                        {ins.windowDays ? ` · 近 ${ins.windowDays} 天窗口` : ''}
                      </p>
                      {ins.shareStatus === 'rejected' && ins.shareNote && (
                        <p className="mt-1 text-[11px] text-bad">驳回理由:{ins.shareNote}</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-2 text-xs leading-5 text-slate-500">该行业还没有洞察报告,点下方按钮生成第一期。</p>
                  )}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {ins && ins.buildStatus === 'idle' && (
                      <Link href={`/insights/${ins.id}`} className="btn-ghost h-8 px-3 text-xs">
                        查看报告
                      </Link>
                    )}
                    <button
                      className="btn-primary h-8 px-3 text-xs"
                      title={m.configured ? undefined : '平台正在配置该行业的监测品牌与问题,配置完成后即可生成'}
                      disabled={!m.configured || runBuild.isPending || ins?.buildStatus === 'running' || busy === `run-${m.industryId}`}
                      onClick={() => {
                        setBusy(`run-${m.industryId}`);
                        runBuild.mutate(m.industryId, { onSettled: () => setBusy(null) });
                      }}
                    >
                      {!m.configured ? '等待平台配置' : ins?.buildStatus === 'running' ? '聚合中…' : ins ? '生成新一期' : '生成第一期'}
                    </button>
                    {ins && ins.buildStatus === 'idle' && ins.status !== 'published' && ins.shareStatus !== 'pending' && (
                      <button
                        className="h-8 rounded border border-slate-200 px-3 text-xs transition-colors hover:border-brand-300 hover:text-brand-700"
                        onClick={() => setShareTarget(ins.id)}
                      >
                        分享到官网
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {(data?.unopened ?? []).map((name) => (
              <div key={`un-${name}`} className="card rise border-dashed p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900">{name}</h3>
                  <Badge label="未开通" tone="slate" />
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  你的品牌属于该行业;申请开通后,平台会配置行业监测品牌与问题,即可生成行业洞察。
                </p>
                <button
                  className="btn-primary mt-4 h-8 px-3 text-xs"
                  disabled={apply.isPending || busy === `apply-${name}`}
                  onClick={() => {
                    setBusy(`apply-${name}`);
                    apply.mutate(name, { onSettled: () => setBusy(null) });
                  }}
                >
                  {busy === `apply-${name}` ? '提交中…' : '申请开通'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 官方洞察流 */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-semibold text-slate-900">官方洞察</h2>
          <span className="text-xs text-slate-400">平台审核发布的公开报告</span>
        </div>
        {(data?.official ?? []).length === 0 ? (
          <p className="card p-6 text-sm text-slate-400">暂无官方发布的行业洞察。</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {(data?.official ?? []).slice(0, 9).map((it) => (
              <Link key={it.id} href={`/insights/${it.id}`} className="card rise p-5 transition-shadow hover:shadow-md">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-brand-700">{it.industry}</span>
                  <span className="metric-num text-[11px] text-slate-400">{it.issue}</span>
                </div>
                <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-6 text-slate-900">{it.title}</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{it.summary}</p>
                {it.publishedAt && (
                  <p className="metric-num mt-2 text-[11px] text-slate-400">{new Date(it.publishedAt).toLocaleDateString('zh-CN')}</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 分享确认弹窗 */}
      {shareTarget != null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/60 p-4" onClick={() => setShareTarget(null)}>
          <div className="animate-fade-up w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-900">分享到官网首页</h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              提交后进入平台审核:审核通过即公开发布在官网首页(面向所有访客);驳回会附理由,你可以在修改后重新分享。
            </p>
            <textarea
              className="input mt-3 h-20 w-full resize-none"
              placeholder="给审核员的留言(可选):想强调的行业背景或结论…"
              value={shareNote}
              onChange={(e) => setShareNote(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setShareTarget(null)}>取消</button>
              <button className="btn-primary" disabled={share.isPending} onClick={() => share.mutate(shareTarget)}>
                {share.isPending ? '提交中…' : '提交审核'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
