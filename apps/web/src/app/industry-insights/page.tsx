'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { INSIGHT_QUESTION_LAYERS, type InsightSummaryDto } from '@geo/shared';

interface MineIndustry {
  industryId: number;
  industry: string;
  /** 自建行业(0013):可删除/配置品牌与问题 */
  owned: boolean;
  /** 订阅的公共/他人行业(0014):可生成可退订,不可配置 */
  subscribed?: boolean;
  /** 已配置监测品牌(未配置时生成按钮置灰,避免必然失败的提交) */
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

interface IndustryBrandRow {
  id: number;
  name: string;
  aliases: string[];
  website: string | null;
  positioning: string | null;
}

interface IndustryQuestionRow {
  id: number;
  textRaw: string;
  type: 'ranking' | 'reputation';
  layer?: string | null;
}

interface HubDto {
  mine: MineIndustry[];
  official: InsightSummaryDto[];
  /** 可订阅行业库(0014 跨行业洞察);configured=平台已配监测品牌(否则订阅后需等配置) */
  library: Array<{ industryId: number; industry: string; configured: boolean }>;
  /** 套餐可开通行业数与已用 */
  quota: number;
  used: number;
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
  // 自服务:新增行业 + 每行业配置面板开关
  const [newIndustryName, setNewIndustryName] = useState('');
  const [configFor, setConfigFor] = useState<number | null>(null);

  const createIndustry = async (name: string) => {
    const clean = name.trim();
    if (clean.length < 2) {
      toast('行业名至少 2 个字', 'err');
      return;
    }
    setBusy('create-industry');
    try {
      const r = await api<{ industryId: number; alreadyOpen: boolean }>('/insights/industries', {
        method: 'POST',
        json: { name: clean },
      });
      toast(r.alreadyOpen ? `「${clean}」已在你的行业列表中` : `行业「${clean}」已创建,展开卡片配置品牌与问题`);
      setNewIndustryName('');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const subscribe = async (industryId: number, name: string) => {
    setBusy(`sub-${industryId}`);
    try {
      await api(`/insights/industries/${industryId}/subscribe`, { method: 'POST' });
      toast(`已订阅「${name}」,现在可以生成该行业的洞察报告`);
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const unsubscribe = async (industryId: number, name: string) => {
    if (!window.confirm(`退订行业「${name}」?报告入口将移除(平台数据不受影响)。`)) return;
    setBusy(`unsub-${industryId}`);
    try {
      await api(`/insights/industries/${industryId}/subscribe`, { method: 'DELETE' });
      toast('已退订');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const removeIndustry = async (industryId: number, name: string) => {
    if (!window.confirm(`删除行业「${name}」?其下洞察报告与配置将一并删除。`)) return;
    setBusy(`remove-${industryId}`);
    try {
      await api(`/insights/industries/${industryId}`, { method: 'DELETE' });
      toast('行业已删除');
      void qc.invalidateQueries({ queryKey: ['insights-hub'] });
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const runBuild = useMutation({
    mutationFn: (industryId: number) =>
      api(`/insights/industries/${industryId}/run`, { method: 'POST', json: { windowDays: 30 } }),
    onSuccess: () => {
      toast('已开始聚合,约 1 分钟后刷新查看');
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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-baseline gap-2 font-semibold text-slate-900">
            我的行业
            <span className="metric-num text-xs font-normal text-slate-400">
              {data ? `${data.used}/${data.quota > 1e6 ? '∞' : data.quota} 个行业额度` : ''}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <input
              className="h-8 w-56 rounded-lg border border-slate-200 px-3 text-xs"
              placeholder="新增行业,如:新能源汽车"
              maxLength={20}
              value={newIndustryName}
              onChange={(e) => setNewIndustryName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && newIndustryName.trim().length >= 2 && void createIndustry(newIndustryName)}
            />
            <button
              className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40"
              disabled={busy === 'create-industry' || newIndustryName.trim().length < 2}
              onClick={() => void createIndustry(newIndustryName)}
            >
              新增行业
            </button>
          </div>
        </div>
        {(data?.mine ?? []).length === 0 && (data?.library ?? []).length === 0 ? (
          data?.hasBrands ? (
            <EmptyState
              title="品牌行业暂未收录"
              text="直接用上方输入框新增行业,或联系平台运营配置公共行业。"
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
                      {m.owned && <Badge label="自建" tone="brand" />}
                      {buildBadge && <Badge label={buildBadge.label} tone={buildBadge.tone} />}
                      {shareBadge && <Badge label={shareBadge.label} tone={shareBadge.tone} />}
                      {m.owned && (
                        <button
                          className="px-1 text-xs text-slate-300 hover:text-bad"
                          title="删除该行业(其下报告与配置一并删除)"
                          onClick={() => void removeIndustry(m.industryId, m.industry)}
                        >
                          ×
                        </button>
                      )}
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
                  ) : !m.configured && m.subscribed ? (
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      该行业的监测品牌与问题由平台侧配置,暂未完成 —— 完成后即可生成第一期。订阅已保留,无需重复操作。
                    </p>
                  ) : !m.configured ? (
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      还没有监测品牌与问题,点下方「先配置品牌与问题」完成配置后即可生成第一期。
                    </p>
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
                      title={
                        m.configured
                          ? undefined
                          : m.owned
                            ? '先展开「配置品牌与问题」,添加行业品牌与问题后即可生成'
                            : '平台正在配置该行业的监测品牌与问题,配置完成后即可生成'
                      }
                      disabled={!m.configured || runBuild.isPending || ins?.buildStatus === 'running' || busy === `run-${m.industryId}`}
                      onClick={() => {
                        setBusy(`run-${m.industryId}`);
                        runBuild.mutate(m.industryId, { onSettled: () => setBusy(null) });
                      }}
                    >
                      {!m.configured
                        ? m.owned
                          ? '先配置品牌与问题'
                          : '等待平台配置'
                        : ins?.buildStatus === 'running'
                          ? '聚合中…'
                          : ins
                            ? '生成新一期'
                            : '生成第一期'}
                    </button>
                    {m.owned && (
                      <button
                        className="h-8 rounded border border-slate-200 px-3 text-xs transition-colors hover:border-brand-300 hover:text-brand-700"
                        onClick={() => setConfigFor(configFor === m.industryId ? null : m.industryId)}
                      >
                        {configFor === m.industryId ? '收起配置' : '配置品牌与问题'}
                      </button>
                    )}
                    {m.subscribed && (
                      <button
                        className="h-8 rounded border border-slate-200 px-3 text-xs text-slate-500 transition-colors hover:border-bad hover:text-bad"
                        title="退订该行业(报告入口移除,平台数据不受影响)"
                        onClick={() => void unsubscribe(m.industryId, m.industry)}
                      >
                        退订
                      </button>
                    )}
                    {ins && ins.buildStatus === 'idle' && ins.status !== 'published' && ins.shareStatus !== 'pending' && (
                      <button
                        className="h-8 rounded border border-slate-200 px-3 text-xs transition-colors hover:border-brand-300 hover:text-brand-700"
                        onClick={() => setShareTarget(ins.id)}
                      >
                        分享到官网
                      </button>
                    )}
                  </div>
                  {configFor === m.industryId && m.owned && (
                    <IndustryConfigPanel industryId={m.industryId} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 行业库(跨行业订阅) */}
      {(data?.library ?? []).length > 0 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-900">行业库</h2>
            <span className="text-xs text-slate-400">订阅后即可生成(计入行业额度);「待配置」行业需平台先完成品牌与问题配置</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {(data?.library ?? []).map((lib) => {
              const full = (data?.used ?? 0) >= (data?.quota ?? 0);
              return (
                <div key={lib.industryId} className="card rise flex items-center justify-between gap-2 p-4">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    {lib.industry}
                    {!lib.configured && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400" title="平台暂未配置该行业的监测品牌与问题,配置完成前无法生成报告">
                        待配置
                      </span>
                    )}
                  </span>
                  <button
                    className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:opacity-40"
                    disabled={busy === `sub-${lib.industryId}` || full}
                    title={full ? '行业额度已满:升级套餐或退订后再试' : lib.configured ? undefined : '可先订阅占位;平台完成配置后即可生成报告'}
                    onClick={() => void subscribe(lib.industryId, lib.industry)}
                  >
                    {busy === `sub-${lib.industryId}` ? '订阅中…' : full ? '额度已满' : '+ 订阅'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

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

/* ============ 自服务配置面板(行业品牌 + 行业问题 + 立即采集) ============ */
function IndustryConfigPanel({ industryId }: { industryId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [brandSuggest, setBrandSuggest] = useState<{ name: string; website: string; positioning: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [brandName, setBrandName] = useState('');
  const [qText, setQText] = useState('');
  const [qType, setQType] = useState<'ranking' | 'reputation'>('ranking');
  const [qLayer, setQLayer] = useState<string | null>(null);
  const [qSuggest, setQSuggest] = useState<Array<{ type: string; text: string }> | null>(null);

  const brands = useQuery({
    queryKey: ['my-industry-brands', industryId],
    queryFn: () => api<IndustryBrandRow[]>(`/insights/industries/${industryId}/brands`),
  });
  const questions = useQuery({
    queryKey: ['my-industry-questions', industryId],
    queryFn: () => api<IndustryQuestionRow[]>(`/insights/industries/${industryId}/questions`),
  });
  // 采集状态:让「立即采集」的效果可见(数据在涨 / 失败多少);面板打开期间每分钟自刷
  const collectStatus = useQuery({
    queryKey: ['my-industry-collect-status', industryId],
    queryFn: () =>
      api<{
        hasShadow: boolean;
        questions: number;
        last24h: { ok: number; failed: number; quotaBlocked: number };
        lastRunAt: string | null;
      }>(`/insights/industries/${industryId}/collect-status`),
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['my-industry-brands', industryId] });
    void qc.invalidateQueries({ queryKey: ['my-industry-questions', industryId] });
    void qc.invalidateQueries({ queryKey: ['my-industry-collect-status', industryId] });
    void qc.invalidateQueries({ queryKey: ['insights-hub'] });
  };
  const run = (key: string, fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(key);
    fn()
      .then(() => {
        invalidate();
        done?.();
      })
      .catch((e) => toast((e as Error).message, 'err'))
      .finally(() => setBusy(null));
  };

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      {/* 行业品牌 */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-slate-800">行业品牌({(brands.data ?? []).length})</h4>
          <button
            className="h-7 rounded bg-brand px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
            disabled={busy === 'suggest-brands'}
            onClick={() =>
              run('suggest-brands', async () => {
                const r = await api<{ suggestions: { name: string; website: string; positioning: string }[] }>(
                  `/insights/industries/${industryId}/suggest-brands`,
                  { method: 'POST' },
                );
                setBrandSuggest(r.suggestions);
                setPicked(new Set(r.suggestions.map((x) => x.name)));
              })
            }
          >
            {busy === 'suggest-brands' ? 'AI 推荐中…' : '✦ AI 推荐品牌'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(brands.data ?? []).map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px]">
              <b className="text-slate-700">{b.name}</b>
              {b.website && <span className="text-slate-400">{b.website.replace('https://', '')}</span>}
              <button
                className="text-slate-300 hover:text-bad"
                title="移除行业品牌"
                onClick={() => run(`rm-b-${b.id}`, () => api(`/insights/industries/${industryId}/brands/${b.id}`, { method: 'DELETE' }))}
              >
                ×
              </button>
            </span>
          ))}
          {(brands.data ?? []).length === 0 && <span className="text-[11px] text-slate-400">还没有行业品牌</span>}
        </div>

        {brandSuggest && (
          <div className="mt-2 rounded border border-slate-200 bg-white p-2.5">
            {brandSuggest.map((sg) => (
              <label key={sg.name} className="flex cursor-pointer items-center gap-2 py-0.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={picked.has(sg.name)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(sg.name);
                    else next.delete(sg.name);
                    setPicked(next);
                  }}
                />
                <b>{sg.name}</b>
                {sg.website && <span className="text-slate-400">{sg.website}</span>}
                {sg.positioning && <span className="text-slate-500">{sg.positioning}</span>}
              </label>
            ))}
            <div className="mt-2 flex gap-2">
              <button
                className="h-7 rounded bg-brand px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
                disabled={busy === 'create-brands' || picked.size === 0}
                onClick={() =>
                  run('create-brands', () =>
                    api(`/insights/industries/${industryId}/brands`, {
                      method: 'POST',
                      json: { brands: brandSuggest.filter((x) => picked.has(x.name)) },
                    }),
                  )
                }
              >
                收录选中 {picked.size} 个
              </button>
              <button className="h-7 px-2 text-[11px] text-slate-400" onClick={() => setBrandSuggest(null)}>取消</button>
            </div>
          </div>
        )}

        <div className="mt-2 flex gap-1.5">
          <input
            className="flex-1 rounded border border-slate-200 px-2 py-1 text-[11px]"
            placeholder="手动添加行业品牌名(回车收录)"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && brandName.trim().length >= 2) {
                const name = brandName.trim();
                run('add-brand', () => api(`/insights/industries/${industryId}/brands`, { method: 'POST', json: { brands: [{ name }] } }), () => setBrandName(''));
              }
            }}
          />
        </div>
      </div>

      {/* 行业问题 */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-slate-800">行业问题({(questions.data ?? []).length})</h4>
          <button
            className="h-7 rounded bg-brand px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
            disabled={busy === 'suggest-q'}
            onClick={() =>
              run('suggest-q', async () => {
                const r = await api<{ questions: Array<{ type: string; text: string }> }>(
                  `/insights/industries/${industryId}/questions`,
                  { method: 'POST', json: { apply: false } },
                );
                setQSuggest(r.questions);
              })
            }
          >
            {busy === 'suggest-q' ? 'AI 生成中…' : '✦ AI 生成行业问题'}
          </button>
        </div>
        <ul className="space-y-1">
          {(questions.data ?? []).map((q) => (
            <li key={q.id} className="flex items-center gap-2 rounded border border-slate-100 bg-white px-2 py-1 text-[11px]">
              <span className={`rounded px-1 py-0.5 text-[10px] ${q.type === 'reputation' ? 'bg-warn-50 text-warn' : 'bg-brand-50 text-brand-700'}`}>
                {q.type === 'reputation' ? '口碑' : '排名'}
              </span>
              {q.layer && <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">{q.layer}</span>}
              <span className="min-w-0 flex-1 truncate">{q.textRaw}</span>
              <button
                className="px-1 text-slate-300 hover:text-bad"
                onClick={() => run(`rm-q-${q.id}`, () => api(`/insights/industries/${industryId}/questions/${q.id}`, { method: 'DELETE' }))}
              >
                删除
              </button>
            </li>
          ))}
          {(questions.data ?? []).length === 0 && <li className="text-[11px] text-slate-400">还没有行业问题</li>}
        </ul>

        {qSuggest && (
          <div className="mt-2 rounded border border-slate-200 bg-white p-2.5">
            {qSuggest.map((q) => (
              <div key={q.text} className="flex items-center gap-2 py-0.5 text-[11px]">
                <span className={`rounded px-1 py-0.5 text-[10px] ${q.type === 'reputation' ? 'bg-warn-50 text-warn' : 'bg-brand-50 text-brand-700'}`}>
                  {q.type === 'reputation' ? '口碑' : '排名'}
                </span>
                {q.text}
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <button
                className="h-7 rounded bg-brand px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
                disabled={busy === 'apply-q'}
                onClick={() => run('apply-q', () => api(`/insights/industries/${industryId}/questions`, { method: 'POST', json: { apply: true } }))}
              >
                下发全部问题
              </button>
              <button className="h-7 px-2 text-[11px] text-slate-400" onClick={() => setQSuggest(null)}>取消</button>
            </div>
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1.5">
          <select className="rounded border border-slate-200 px-2 py-1 text-[11px]" value={qType} onChange={(e) => setQType(e.target.value as 'ranking' | 'reputation')}>
            <option value="ranking">排名</option>
            <option value="reputation">口碑</option>
          </select>
          <select className="rounded border border-slate-200 px-2 py-1 text-[11px]" value={qLayer ?? ''} onChange={(e) => setQLayer(e.target.value || null)}>
            <option value="">未分层</option>
            {INSIGHT_QUESTION_LAYERS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <input
            className="flex-1 rounded border border-slate-200 px-2 py-1 text-[11px]"
            placeholder="手动添加行业问题(8-60 字,回车添加)"
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && qText.trim().length >= 8) {
                const text = qText.trim();
                const type = qType;
                const layer = qLayer;
                run('add-q', () => api(`/insights/industries/${industryId}/questions/manual`, { method: 'POST', json: { text, type, layer } }), () => setQText(''));
              }
            }}
          />
        </div>
      </div>

      {/* 立即采集:采集 = 去 AI 引擎实际提问、把数据采回库(可反复点追加样本);生成新一期 = 把已采数据聚合成报告 */}
      <button
        className="h-9 w-full rounded-lg bg-good text-xs font-semibold text-white disabled:opacity-50"
        disabled={busy === 'collect'}
        onClick={() =>
          run('collect', () => api(`/insights/industries/${industryId}/collect`, { method: 'POST' }), () =>
            toast('已触发采集:约 1 分钟内开始,20~60 分钟出数;期间可再点追加样本。数据到库后点「生成新一期」出报告'),
          )
        }
      >
        {busy === 'collect' ? '触发中…' : '▶ 立即采集(品牌+问题已同步到采集引擎)'}
      </button>
      {collectStatus.data && (
        <p className="metric-num text-[10px] leading-4 text-slate-500">
          采集状态:
          {collectStatus.data.hasShadow
            ? `${collectStatus.data.questions} 个问题在采 · 近 24h 有效回答 ${collectStatus.data.last24h.ok} 条` +
              (collectStatus.data.last24h.failed > 0 || collectStatus.data.last24h.quotaBlocked > 0
                ? ` · 失败 ${collectStatus.data.last24h.failed}` + (collectStatus.data.last24h.quotaBlocked > 0 ? ` / 拦截 ${collectStatus.data.last24h.quotaBlocked}` : '') + '(多为引擎未登录)'
                : '') +
              (collectStatus.data.lastRunAt ? ` · 最近采集 ${new Date(collectStatus.data.lastRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '')
            : '尚未初始化(点上方按钮开始首轮采集)'}
        </p>
      )}
      <p className="text-[10px] leading-4 text-slate-400">
        「立即采集」把 AI 回答采回数据库,可反复点击追加样本(数据越多比率越稳);「生成新一期」把已采数据聚合成报告,二者分工不同。
      </p>
    </div>
  );
}
