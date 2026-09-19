'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiDownload } from '@/lib/api';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/ui';
import { InsightBlocks } from '@/components/insight-charts';
import { type InsightBlock, InsightBuildStatus } from '@geo/shared';

/**
 * 平台后台 · 行业洞察生成器(向导式,docs/01 IA ⑤ 市场化):
 * ① 选行业 → ② 监测品牌(AI 推荐+人工) → ③ 行业问题(AI 生成+人工)
 * → ④ AI 生成报告(聚合+撰稿) → ⑤ 预览微调 → ⑥ 发布。
 */

interface IndustryRow {
  id: number;
  name: string;
  sort: number;
  active: boolean;
}

interface IndustryBrandRow {
  id: number;
  name: string;
  aliases: string[];
  website: string | null;
  positioning: string | null;
}

interface BrandSuggestion {
  name: string;
  website: string;
  aliases: string[];
  positioning: string;
}

interface IndustryQuestionRow {
  id: number;
  textRaw: string;
  type: 'ranking' | 'reputation';
}

interface AdminInsightDto {
  id: number;
  industry: string;
  issue: string;
  title: string;
  summary: string;
  blocks: InsightBlock[];
  status: 'draft' | 'published';
  featured: boolean;
  buildStatus: InsightBuildStatus;
  buildError: string | null;
  builtAt: string | null;
  windowDays: number | null;
  disclosure: string | null;
}

export default function AdminInsightsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const industries = useQuery({ queryKey: ['admin-insight-industries'], queryFn: () => api<IndustryRow[]>('/admin/insights/industries') });
  const list = useQuery({
    queryKey: ['admin-insights'],
    queryFn: () => api<AdminInsightDto[]>('/admin/insights'),
    refetchInterval: (q) =>
      ((q.state.data ?? []) as AdminInsightDto[]).some((r) => r.buildStatus === 'running') ? 2500 : false,
  });

  const [newIndustry, setNewIndustry] = useState('');
  const [wizard, setWizard] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editDisclosure, setEditDisclosure] = useState('');
  const [disclosureFor, setDisclosureFor] = useState<number | null>(null);
  const [windowDays, setWindowDays] = useState<number | null>(30);

  // 用户分享审核(分享 → 审核通过 → 官网首页)
  const shares = useQuery({ queryKey: ['admin-insight-shares'], queryFn: () => api<AdminInsightDto[]>('/admin/insights/shares'), refetchInterval: 30_000 });
  const review = useMutation({
    mutationFn: (input: { id: number; approve: boolean; note?: string }) =>
      api(`/admin/insights/${input.id}/review`, { method: 'POST', json: { approve: input.approve, note: input.note } }),
    onSuccess: (_d, v) => {
      toast(v.approve ? '已通过并发布到官网首页' : '已驳回');
      void queryClient.invalidateQueries({ queryKey: ['admin-insight-shares'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-insights'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });
  const [rejectFor, setRejectFor] = useState<number | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const [brandSuggest, setBrandSuggest] = useState<BrandSuggestion[] | null>(null);
  const [brandPicked, setBrandPicked] = useState<Set<string>>(new Set());
  const [manualBrandDesc, setManualBrandDesc] = useState('');
  const [manualQ, setManualQ] = useState('');
  const [manualQType, setManualQType] = useState<'ranking' | 'reputation'>('ranking');
  const [manualQLayer, setManualQLayer] = useState<string | null>(null);
  const [qSuggest, setQSuggest] = useState<Array<{ type: string; text: string }> | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-insights'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-insight-industries'] });
  };
  const refreshWizard = (id: number) => {
    void queryClient.invalidateQueries({ queryKey: ['wiz-brands', id] });
    void queryClient.invalidateQueries({ queryKey: ['wiz-questions', id] });
  };

  const addIndustry = async () => {
    if (!newIndustry.trim()) return;
    try {
      const r = await api<IndustryRow>('/admin/insights/industries', { method: 'POST', json: { name: newIndustry.trim() } });
      setNewIndustry('');
      refresh();
      setWizard(r.id);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const removeIndustry = async (row: IndustryRow) => {
    if (!window.confirm(`删除行业「${row.name}」?其下报告需先删除。`)) return;
    try {
      await api(`/admin/insights/industries/${row.id}`, { method: 'DELETE' });
      toast('行业已删除');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  return (
    <>
      <PageHeader
        title="行业洞察生成器"
        desc="① 选行业 → ② 监测品牌(AI 推荐+人工) → ③ 行业问题(AI 生成+人工) → ④ AI 生成报告 → ⑤ 预览微调 → ⑥ 发布"
      />

      {/* 用户分享审核(待处理置顶) */}
      {(shares.data ?? []).length > 0 && (
        <section className="card mt-4 border-warn/40 p-5">
          <h2 className="mb-1 font-semibold text-slate-900">
            分享审核 <span className="ml-1 rounded bg-warn-50 px-1.5 py-0.5 text-[10px] text-warn">{(shares.data ?? []).length} 份待处理</span>
          </h2>
          <p className="mb-3 text-xs text-slate-500">用户提交分享的行业洞察;通过即发布到官网首页(公开)。</p>
          <div className="space-y-2">
            {(shares.data ?? []).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    <span className="mr-2 text-xs text-brand-700">{r.industry}</span>
                    {r.title}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{r.summary}</p>
                  {(r as { shareNote?: string | null }).shareNote && (
                    <p className="mt-0.5 text-xs text-slate-400">用户留言:{(r as { shareNote?: string }).shareNote}</p>
                  )}
                </div>
                <a href={`/insights/${r.id}`} target="_blank" rel="noreferrer" className="btn-ghost h-8 px-3 text-xs">
                  预览
                </a>
                <button className="btn-primary h-8 px-3 text-xs" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, approve: true })}>
                  通过并发布
                </button>
                <button
                  className="h-8 rounded border border-slate-200 px-3 text-xs transition-colors hover:border-bad hover:text-bad"
                  onClick={() => setRejectFor(r.id)}
                >
                  驳回
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 驳回理由弹窗 */}
      {rejectFor != null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/60 p-4" onClick={() => setRejectFor(null)}>
          <div className="animate-fade-up w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-900">驳回分享</h3>
            <textarea
              className="input mt-3 h-20 w-full resize-none"
              placeholder="驳回理由(会展示给提交用户)"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setRejectFor(null)}>取消</button>
              <button
                className="btn-primary"
                disabled={review.isPending}
                onClick={() => review.mutate({ id: rejectFor, approve: false, note: rejectNote }, { onSuccess: () => { setRejectFor(null); setRejectNote(''); } })}
              >
                确认驳回
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ① 行业 */}
      <section className="card rise mt-4 p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">① 行业</h2>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            报告数据窗口
            <select
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={windowDays ?? ''}
              onChange={(e) => setWindowDays(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
              <option value="90">近 90 天</option>
              <option value="">全量历史</option>
            </select>
          </label>
        </div>
        <div className="mb-3 flex gap-2">
          <input
            placeholder="新增行业,如:新能源汽车 / 美妆个护 / 家电"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={newIndustry}
            onChange={(e) => setNewIndustry(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addIndustry()}
          />
          <button className="btn-ghost" onClick={() => void addIndustry()}>添加并开始向导</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(industries.data ?? []).map((row) => {
            const report = (list.data ?? []).find((r) => r.industry === row.name);
            return (
              <span
                key={row.id}
                className={`group inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  row.active ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-400'
                }`}
              >
                <button onClick={() => setWizard(wizard === row.id ? null : row.id)}>
                  {row.name}
                  {report && <span className="ml-1 text-[10px] text-slate-400">({report.issue})</span>}
                </button>
                <button
                  className="text-slate-300 transition-colors hover:text-bad group-hover:text-slate-400"
                  title="删除行业"
                  onClick={() => void removeIndustry(row)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      </section>

      {/* ② ③ 向导面板 */}
      {wizard != null && (
        <IndustryWizard
          industryId={wizard}
          windowDays={windowDays}
          busy={busy}
          setBusy={setBusy}
          brandSuggest={brandSuggest}
          setBrandSuggest={setBrandSuggest}
          brandPicked={brandPicked}
          setBrandPicked={setBrandPicked}
          manualBrandDesc={manualBrandDesc}
          setManualBrandDesc={setManualBrandDesc}
          manualQ={manualQ}
          setManualQ={setManualQ}
          manualQType={manualQType}
          setManualQType={setManualQType}
          manualQLayer={manualQLayer}
          setManualQLayer={setManualQLayer}
          qSuggest={qSuggest}
          setQSuggest={setQSuggest}
          refreshWizard={refreshWizard}
          refreshAll={refresh}
          toast={toast}
        />
      )}

      {/* ④⑤⑥ 报告 */}
      <section className="mt-4 space-y-3">
        <ReportsSection
          list={list.data ?? []}
          industries={industries.data ?? []}
          windowDays={windowDays}
          busy={busy}
          setBusy={setBusy}
          expanded={expanded}
          setExpanded={setExpanded}
          editing={editing}
          setEditing={setEditing}
          editTitle={editTitle}
          setEditTitle={setEditTitle}
          editDisclosure={editDisclosure}
          setEditDisclosure={setEditDisclosure}
          disclosureFor={disclosureFor}
          setDisclosureFor={setDisclosureFor}
          editSummary={editSummary}
          setEditSummary={setEditSummary}
          refresh={refresh}
          toast={toast}
        />
      </section>
    </>
  );
}

/* ============ ②③ 行业向导面板 ============ */
function IndustryWizard(props: {
  industryId: number;
  windowDays: number | null;
  busy: string | null;
  setBusy: (v: string | null) => void;
  brandSuggest: BrandSuggestion[] | null;
  setBrandSuggest: (v: BrandSuggestion[] | null) => void;
  brandPicked: Set<string>;
  setBrandPicked: (v: Set<string>) => void;
  manualBrandDesc: string;
  setManualBrandDesc: (v: string) => void;
  manualQ: string;
  setManualQ: (v: string) => void;
  manualQType: 'ranking' | 'reputation';
  setManualQType: (v: 'ranking' | 'reputation') => void;
  manualQLayer: string | null;
  setManualQLayer: (v: string | null) => void;
  qSuggest: Array<{ type: string; text: string }> | null;
  setQSuggest: (v: Array<{ type: string; text: string }> | null) => void;
  refreshWizard: (id: number) => void;
  refreshAll: () => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const {
    industryId, busy, setBusy, brandSuggest, setBrandSuggest, brandPicked, setBrandPicked,
    manualBrandDesc, setManualBrandDesc, manualQ, setManualQ, manualQType, setManualQType,
    qSuggest, setQSuggest, refreshWizard, toast,
  } = props;

  const brands = useQuery({
    queryKey: ['wiz-brands', industryId],
    queryFn: () => api<IndustryBrandRow[]>(`/admin/insights/industries/${industryId}/brands`),
  });
  const discoverWebsite = async (brandId: number) => {
    setBusy(`discover-${brandId}`);
    try {
      const r = await api<{ website: string | null; discovered?: boolean; error?: string; note?: string }>(
        `/admin/insights/industries/${industryId}/brands/${brandId}/discover-website`,
        { method: 'POST' },
      );
      if (r.website) {
        toast(`官网已自动填入:${r.website.replace('https://', '')}`);
        refreshWizard(industryId);
      } else {
        toast(r.error ?? r.note ?? '未能发现官网', 'err');
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };
  const questions = useQuery({
    queryKey: ['wiz-questions', industryId],
    queryFn: () => api<IndustryQuestionRow[]>(`/admin/insights/industries/${industryId}/questions`),
  });

  const suggestBrands = async () => {
    setBusy('suggest-brands');
    try {
      const r = await api<{ suggestions: BrandSuggestion[] }>(`/admin/insights/industries/${industryId}/suggest-brands`, { method: 'POST' });
      setBrandSuggest(r.suggestions);
      setBrandPicked(new Set(r.suggestions.map((s) => s.name)));
      toast(`AI 推荐 ${r.suggestions.length} 个品牌,勾选后创建`);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const createBrands = async (list: BrandSuggestion[]) => {
    setBusy('create-brands');
    try {
      const r = await api<{ created: Array<{ id: number; name: string }> }>(`/admin/insights/industries/${industryId}/brands`, {
        method: 'POST',
        json: { brands: list },
      });
      toast(`已收录 ${r.created.length} 个行业品牌`);
      setBrandSuggest(null);
      refreshWizard(industryId);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const removeBrand = async (brandId: number) => {
    try {
      await api(`/admin/insights/industries/${industryId}/brands/${brandId}`, { method: 'DELETE' });
      refreshWizard(industryId);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const collectNow = async () => {
    setBusy('collect');
    try {
      await api(`/admin/insights/industries/${industryId}/collect`, { method: 'POST' });
      toast('采集已触发:行业品牌+问题已同步,约 20-60 分钟出数');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const genQuestions = async (apply: boolean) => {
    setBusy(apply ? 'apply-q' : 'suggest-q');
    try {
      const r = await api<{ questions: Array<{ type: string; text: string }>; inserted: number }>(`/admin/insights/industries/${industryId}/questions`, {
        method: 'POST',
        json: { apply },
      });
      if (apply) {
        toast(`已下发 ${r.questions.length} 个行业问题到全部品牌`);
        setQSuggest(null);
        refreshWizard(industryId);
      } else {
        setQSuggest(r.questions);
        toast(`AI 生成 ${r.questions.length} 个行业问题,确认后下发`);
      }
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const addManualQ = async () => {
    setBusy('add-q');
    try {
      await api(`/admin/insights/industries/${industryId}/questions/manual`, { method: 'POST', json: { text: manualQ, type: manualQType } });
      toast('问题已添加到行业全部品牌');
      setManualQ('');
      refreshWizard(industryId);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const removeQ = async (qid: number) => {
    try {
      await api(`/admin/insights/industries/${industryId}/questions/${qid}`, { method: 'DELETE' });
      refreshWizard(industryId);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  return (
    <>
      {/* ② 监测品牌 */}
      <section className="card rise-1 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">② 监测品牌</h2>
          <button
            className="h-8 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:opacity-50"
            disabled={busy === 'suggest-brands'}
            onClick={() => void suggestBrands()}
          >
            {busy === 'suggest-brands' ? 'AI 推荐中…' : '✦ AI 推荐品牌'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(brands.data ?? []).map((b) => (
            <span key={b.id} className="group inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs">
              <b className="text-slate-800">{b.name}</b>
              {b.aliases?.length > 0 && <span className="text-slate-400">({b.aliases.join('/')})</span>}
              {b.website ? (
                <span className="text-brand-700">{b.website.replace('https://', '')}</span>
              ) : (
                <button
                  className="underline decoration-dotted text-slate-400 hover:text-brand-700 disabled:opacity-40"
                  disabled={busy === `discover-${b.id}`}
                  title="LLM 提议官网,探测可达后自动填入(官网被引维度的数据源)"
                  onClick={() => void discoverWebsite(b.id)}
                >
                  {busy === `discover-${b.id}` ? '发现中…' : '发现官网'}
                </button>
              )}
              <button
                className="text-slate-300 transition-colors hover:text-bad group-hover:text-slate-400"
                title="移除行业品牌"
                onClick={() => void removeBrand(b.id)}
              >
                ×
              </button>
            </span>
          ))}
          {(brands.data ?? []).length === 0 && <p className="text-sm text-slate-400">还没有行业品牌——用 AI 推荐或手动添加</p>}
        </div>

        {brandSuggest && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3">
            <p className="mb-2 text-xs font-medium text-slate-600">AI 推荐(勾选后收录为报告主体):</p>
            <div className="space-y-1.5">
              {brandSuggest.map((s) => (
                <label key={s.name} className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={brandPicked.has(s.name)}
                    onChange={(e) => {
                      const next = new Set(brandPicked);
                      if (e.target.checked) next.add(s.name);
                      else next.delete(s.name);
                      setBrandPicked(next);
                    }}
                  />
                  <span>
                    <b>{s.name}</b>
                    {s.website && <span className="ml-1 text-slate-400">{s.website}</span>}
                    {s.positioning && <span className="block text-slate-500">{s.positioning}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                className="h-8 rounded bg-brand px-3 text-xs font-semibold text-white disabled:opacity-50"
                disabled={busy === 'create-brands' || brandPicked.size === 0}
                onClick={() => void createBrands(brandSuggest.filter((s) => brandPicked.has(s.name)))}
              >
                {busy === 'create-brands' ? '收录中…' : `收录选中 ${brandPicked.size} 个`}
              </button>
              <button className="h-8 px-2 text-xs text-slate-400" onClick={() => setBrandSuggest(null)}>取消</button>
            </div>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <input
            placeholder="手动添加品牌名(回车收录)"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
            value={manualBrandDesc}
            onChange={(e) => setManualBrandDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualBrandDesc.trim().length >= 2) {
                void createBrands([{ name: manualBrandDesc.trim(), website: '', aliases: [], positioning: '' }]);
                setManualBrandDesc('');
              }
            }}
          />
          <button
            className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 disabled:opacity-40"
            disabled={manualBrandDesc.trim().length < 2}
            onClick={() => {
              void createBrands([{ name: manualBrandDesc.trim(), website: '', aliases: [], positioning: '' }]);
              setManualBrandDesc('');
            }}
          >
            添加品牌
          </button>
        </div>
      </section>

      {/* ③ 行业问题 */}
      <section className="card rise-2 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">③ 行业问题</h2>
          <button
            className="h-8 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:opacity-50"
            disabled={busy === 'suggest-q'}
            onClick={() => void genQuestions(false)}
          >
            {busy === 'suggest-q' ? 'AI 生成中…' : '✦ AI 生成行业问题'}
          </button>
        </div>
        <p className="mb-2 text-xs text-slate-400">行业视角的问题(AI 回答中自然出现多品牌),自动挂到该行业全部品牌。</p>
        <ul className="space-y-1">
          {(questions.data ?? []).map((q) => (
            <li key={q.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-1.5 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${q.type === 'reputation' ? 'bg-warn-50 text-warn' : 'bg-brand-50 text-brand-700'}`}>
                {q.type === 'reputation' ? '口碑' : '排名'}
              </span>
              <span className="min-w-0 flex-1 truncate" title={q.textRaw}>{q.textRaw}</span>
              <button className="px-1.5 text-xs text-slate-400 hover:text-slate-800" onClick={() => void removeQ(q.id)}>删除</button>
            </li>
          ))}
          {(questions.data ?? []).length === 0 && <li className="text-sm text-slate-400">还没有行业问题</li>}
        </ul>

        {(questions.data ?? []).length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <button
              className="h-9 rounded-lg bg-good px-4 text-xs font-semibold text-white disabled:opacity-50"
              disabled={busy === 'collect'}
              onClick={() => void collectNow()}
            >
              {busy === 'collect' ? '触发中…' : '▶ 立即采集(品牌+问题已同步)'}
            </button>
            <span className="text-[11px] text-slate-400">采集完成后回报表区点「④ 生成」;之后每周一自动更新</span>
          </div>
        )}

        {qSuggest && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3">
            <p className="mb-2 text-xs font-medium text-slate-600">AI 生成的问题清单:</p>
            <ul className="space-y-1">
              {qSuggest.map((q) => (
                <li key={q.text} className="flex items-center gap-2 text-xs">
                  <span className={`rounded px-1 py-0.5 text-[10px] ${q.type === 'reputation' ? 'bg-warn-50 text-warn' : 'bg-brand-50 text-brand-700'}`}>
                    {q.type === 'reputation' ? '口碑' : '排名'}
                  </span>
                  {q.text}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <button
                className="h-8 rounded bg-brand px-3 text-xs font-semibold text-white disabled:opacity-50"
                disabled={busy === 'apply-q'}
                onClick={() => void genQuestions(true)}
              >
                {busy === 'apply-q' ? '下发中…' : `下发 ${qSuggest.length} 个问题`}
              </button>
              <button className="h-8 px-2 text-xs text-slate-400" onClick={() => setQSuggest(null)}>取消</button>
            </div>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <select
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            value={manualQType}
            onChange={(e) => setManualQType(e.target.value as 'ranking' | 'reputation')}
          >
            <option value="ranking">排名</option>
            <option value="reputation">口碑</option>
          </select>
          <input
            placeholder="手动添加行业问题(8-60字)"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
            value={manualQ}
            onChange={(e) => setManualQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && manualQ.trim().length >= 8 && void addManualQ()}
          />
          <button
            className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 disabled:opacity-40"
            disabled={manualQ.trim().length < 8}
            onClick={() => void addManualQ()}
          >
            添加
          </button>
        </div>
      </section>
    </>
  );
}

/* ============ ④⑤⑥ 报告 ============ */
function ReportsSection(props: {
  list: AdminInsightDto[];
  industries: IndustryRow[];
  windowDays: number | null;
  busy: string | null;
  setBusy: (v: string | null) => void;
  expanded: number | null;
  setExpanded: (v: number | null) => void;
  editing: number | null;
  setEditing: (v: number | null) => void;
  editTitle: string;
  setEditTitle: (v: string) => void;
  editDisclosure: string;
  setEditDisclosure: (v: string) => void;
  disclosureFor: number | null;
  setDisclosureFor: (v: number | null) => void;
  editSummary: string;
  setEditSummary: (v: string) => void;
  refresh: () => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const { list, industries, windowDays, busy, setBusy, expanded, setExpanded, editing, setEditing, editTitle, setEditTitle, editSummary, setEditSummary, editDisclosure, setEditDisclosure, setDisclosureFor, refresh, toast } = props;

  const run = async (industry: IndustryRow) => {
    setBusy(`run:${industry.id}`);
    try {
      await api(`/admin/insights/industries/${industry.id}/run`, {
        method: 'POST',
        json: windowDays ? { windowDays } : {},
      });
      toast(`「${industry.name}」AI 生成中:聚合采集事实 + 撰稿`);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const togglePublish = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, { method: 'PATCH', json: { status: row.status === 'published' ? 'draft' : 'published', featured: row.featured } });
      toast(row.status === 'published' ? '已下线' : '已发布');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const toggleFeatured = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, { method: 'PATCH', json: { status: row.status, featured: !row.featured } });
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const saveEdit = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, { method: 'PATCH', json: { status: row.status, featured: row.featured, title: editTitle, summary: editSummary, disclosure: editDisclosure } });
      toast('已保存');
      setEditing(null);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const downloadPdf = async (row: AdminInsightDto) => {
    setBusy(`pdf:${row.id}`);
    try {
      await apiDownload(`/admin/insights/${row.id}/pdf`, `insight-${row.id}.pdf`);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: AdminInsightDto) => {
    if (!window.confirm(`删除报告「${row.title}」?`)) return;
    try {
      await api(`/admin/insights/${row.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  return (
    <>
      <h2 className="mt-2 px-1 text-sm font-semibold text-slate-900">④⑤⑥ 报告生成 · 预览 · 发布</h2>
      {list.map((row) => (
        <div key={row.id} className="card p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{row.industry} · {row.issue}</span>
                {row.status === 'published' && <span className="rounded bg-good-50 px-1.5 py-0.5 text-[10px] font-medium text-good">已发布</span>}
                {row.featured && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">官网精选</span>}
                {row.buildStatus === 'running' && <span className="rounded bg-warn-50 px-1.5 py-0.5 text-[10px] text-warn">生成中…</span>}
                {row.buildStatus === 'failed' && (
                  <span className="rounded bg-bad-50 px-1.5 py-0.5 text-[10px] text-bad" title={row.buildError ?? ''}>失败:{(row.buildError ?? '').slice(0, 40)}</span>
                )}
              </div>
              {editing === row.id ? (
                <div className="mt-2 space-y-2">
                  <input className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={60} />
                  <textarea className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs leading-5" rows={2} value={editSummary} onChange={(e) => setEditSummary(e.target.value)} maxLength={160} />
                  <textarea className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs leading-5" rows={2} value={editDisclosure} onChange={(e) => setEditDisclosure(e.target.value)} maxLength={400} placeholder="披露/偏向说明(报告尾部展示,留空不展示):利益关系、题目偏向等" />
                  <div className="flex gap-2">
                    <button className="btn-primary h-8 px-3 text-xs" onClick={() => void saveEdit(row)}>保存</button>
                    <button className="btn-ghost h-8 px-3 text-xs" onClick={() => setEditing(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <h3 className="mt-1.5 text-[15px] font-semibold text-slate-900">{row.title || '(未命名)'}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{row.summary}</p>
                </>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {(() => {
                const ind = industries.find((i) => i.name === row.industry);
                return ind ? (
                  <button
                    className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand disabled:opacity-50"
                    disabled={row.buildStatus === 'running' || busy === `run:${ind.id}`}
                    onClick={() => void run(ind)}
                  >
                    {row.buildStatus === 'running' || busy === `run:${ind.id}` ? '生成中…' : '④ 重新生成'}
                  </button>
                ) : null;
              })()}
              <button
                className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 hover:border-brand-300"
                onClick={() => {
                  setExpanded(expanded === row.id ? null : row.id);
                  setDisclosureFor(expanded === row.id ? null : row.id);
                  setEditDisclosure(row.disclosure ?? '');
                  if (editing !== row.id) {
                    setEditTitle(row.title);
                    setEditSummary(row.summary);
                  }
                }}
              >
                {expanded === row.id ? '收起' : '⑤ 预览 / 微调'}
              </button>
              <button
                className={`h-8 rounded-lg px-3 text-xs font-medium ${row.status === 'published' ? 'bg-good-50 text-good' : 'bg-brand text-white'}`}
                onClick={() => void togglePublish(row)}
              >
                {row.status === 'published' ? '下线' : '⑥ 发布'}
              </button>
              <button
                className={`h-8 rounded-lg border px-2.5 text-xs ${row.featured ? 'border-brand-300 bg-brand-50 text-brand-700' : 'bg-white text-slate-500'}`}
                title="官网首页精选"
                onClick={() => void toggleFeatured(row)}
              >
                ★
              </button>
              <button
                className="h-8 rounded-lg border bg-white px-2.5 text-xs text-slate-600 disabled:opacity-50"
                disabled={busy === `pdf:${row.id}` || row.buildStatus === 'running'}
                onClick={() => void downloadPdf(row)}
              >
                PDF
              </button>
              <button className="h-8 px-2 text-xs text-slate-400 hover:text-slate-800" onClick={() => void remove(row)}>删除</button>
            </div>
          </div>
          {expanded === row.id && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <InsightBlocks blocks={row.blocks} />
              <button className="mt-3 text-xs text-brand-600 hover:underline" onClick={() => setEditing(row.id)}>
                微调标题/摘要 →
              </button>
            </div>
          )}
        </div>
      ))}
      {list.length === 0 && (
        <div className="card flex flex-col items-center justify-center px-8 py-12 text-center">
          <p className="text-sm text-slate-500">
            还没有报告——完成向导 ②③(品牌+问题,等首轮采集出数)后,在报告区点「④ 重新生成」产出第一期
          </p>
        </div>
      )}
    </>
  );
}
