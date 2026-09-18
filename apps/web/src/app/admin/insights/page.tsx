'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, apiDownload } from '@/lib/api';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';
import { InsightBlocks } from '@/components/insight-charts';
import type { InsightBlock, InsightBuildStatus } from '@geo/shared';

/**
 * 平台后台 · 行业洞察(精简重构):AI + 采集自动成稿。
 * 选行业 → 「AI 生成」一键完成(聚合采集事实 + LLM 撰稿)→ 预览 → 发布。
 * 不再暴露 blocks JSON 手工编辑;标题/摘要可微调。
 */

interface IndustryRow {
  id: number;
  name: string;
  sort: number;
  active: boolean;
}

interface AdminInsightDto {
  id: number;
  industry: string;
  issue: string;
  title: string;
  summary: string;
  cover: Record<string, unknown>;
  blocks: InsightBlock[];
  status: 'draft' | 'published';
  featured: boolean;
  buildStatus: InsightBuildStatus;
  buildError: string | null;
  builtAt: string | null;
  windowDays: number | null;
  publishedAt: string | null;
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
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-insights'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-insight-industries'] });
  };

  // 构建完成后自动刷新一次(轮询由 refetchInterval 负责)
  useEffect(() => {
    const done = (list.data ?? []).filter((r) => r.buildStatus !== 'running');
    if (done.length > 0) return;
  }, [list.data]);

  const addIndustry = async () => {
    if (!newIndustry.trim()) return;
    try {
      await api('/admin/insights/industries', { method: 'POST', json: { name: newIndustry.trim() } });
      setNewIndustry('');
      refresh();
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

  const toggleIndustry = async (row: IndustryRow) => {
    await api(`/admin/insights/industries/${row.id}`, { method: 'PATCH', json: { active: !row.active } });
    refresh();
  };

  /** AI 生成:行业无报告则自动创建并聚合 + LLM 撰稿;有报告则重新生成覆盖。 */
  const generate = async (industry: IndustryRow) => {
    setBusy(`ind:${industry.id}`);
    try {
      await api(`/admin/insights/industries/${industry.id}/run`, {
        method: 'POST',
        json: windowDays ? { windowDays } : {},
      });
      toast(`「${industry.name}」AI 生成中:聚合采集事实 + 撰稿,完成后自动刷新`);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const togglePublish = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, {
        method: 'PATCH',
        json: { status: row.status === 'published' ? 'draft' : 'published', featured: row.featured },
      });
      toast(row.status === 'published' ? '已下线' : '已发布');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const toggleFeatured = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, {
        method: 'PATCH',
        json: { status: row.status, featured: !row.featured },
      });
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  const saveEdit = async (row: AdminInsightDto) => {
    try {
      await api(`/admin/insights/${row.id}`, {
        method: 'PATCH',
        json: { status: row.status, featured: row.featured, title: editTitle, summary: editSummary },
      });
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

  if (industries.isLoading || list.isLoading) return <Skeleton />;

  return (
    <>
      <PageHeader
        title="行业洞察"
        desc="选行业 → AI 生成:自动聚合本行业监测数据 + LLM 撰稿成稿 → 预览微调 → 发布(会员总览可见,精选上官网首页)"
      />

      {/* ===== 行业 ===== */}
      <section className="card rise mt-4 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">洞察行业</h2>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            数据窗口
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
            placeholder="新增行业,如:新能源汽车 / 美妆护肤"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={newIndustry}
            onChange={(e) => setNewIndustry(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addIndustry()}
          />
          <button className="btn-ghost" onClick={() => void addIndustry()}>
            添加
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(industries.data ?? []).map((row) => (
            <span
              key={row.id}
              className={`group inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                row.active ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-400'
              }`}
            >
              <button title={row.active ? '点击停用' : '点击启用'} onClick={() => void toggleIndustry(row)}>
                {row.name}
              </button>
              <button
                className="text-slate-300 transition-colors hover:text-bad group-hover:text-slate-400"
                title="删除行业"
                onClick={() => void removeIndustry(row)}
              >
                ×
              </button>
              <button
                className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40"
                disabled={busy === `ind:${row.id}` || !row.active}
                title="AI 生成:聚合采集数据 + LLM 撰稿(无报告自动创建)"
                onClick={() => void generate(row)}
              >
                {busy === `ind:${row.id}` ? '生成中…' : 'AI 生成'}
              </button>
            </span>
          ))}
        </div>
      </section>

      {/* ===== 报告列表 ===== */}
      <section className="mt-4 space-y-3">
        {(list.data ?? []).map((row) => (
          <div key={row.id} className="card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {row.industry} · {row.issue}
                  </span>
                  {row.status === 'published' && (
                    <span className="rounded bg-good-50 px-1.5 py-0.5 text-[10px] font-medium text-good">已发布</span>
                  )}
                  {row.featured && (
                    <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">官网精选</span>
                  )}
                  {row.buildStatus === 'running' && (
                    <span className="rounded bg-warn-50 px-1.5 py-0.5 text-[10px] text-warn">生成中…</span>
                  )}
                  {row.buildStatus === 'failed' && (
                    <span className="rounded bg-bad-50 px-1.5 py-0.5 text-[10px] text-bad" title={row.buildError ?? ''}>
                      失败:{(row.buildError ?? '').slice(0, 40)}
                    </span>
                  )}
                </div>
                {editing === row.id ? (
                  <div className="mt-2 space-y-2">
                    <input
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      maxLength={60}
                    />
                    <textarea
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs leading-5"
                      rows={2}
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                      maxLength={160}
                    />
                    <div className="flex gap-2">
                      <button className="btn-primary h-8 px-3 text-xs" onClick={() => void saveEdit(row)}>
                        保存
                      </button>
                      <button className="btn-ghost h-8 px-3 text-xs" onClick={() => setEditing(null)}>
                        取消
                      </button>
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
                <button
                  className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand"
                  onClick={() => {
                    const ind = (industries.data ?? []).find((i) => i.name === row.industry);
                    if (ind) void generate(ind);
                  }}
                  disabled={row.buildStatus === 'running'}
                >
                  {row.buildStatus === 'running' ? '生成中…' : '重新生成'}
                </button>
                <button
                  className="h-8 rounded-lg border bg-white px-3 text-xs font-medium text-slate-600 hover:border-brand-300"
                  onClick={() => {
                    setExpanded(expanded === row.id ? null : row.id);
                    if (editing !== row.id) {
                      setEditTitle(row.title);
                      setEditSummary(row.summary);
                    }
                  }}
                >
                  {expanded === row.id ? '收起' : '预览 / 微调'}
                </button>
                <button
                  className={`h-8 rounded-lg px-3 text-xs font-medium ${
                    row.status === 'published' ? 'bg-good-50 text-good' : 'bg-brand text-white'
                  }`}
                  onClick={() => void togglePublish(row)}
                >
                  {row.status === 'published' ? '下线' : '发布'}
                </button>
                <button
                  className={`h-8 rounded-lg border px-2.5 text-xs ${row.featured ? 'border-brand-300 bg-brand-50 text-brand-700' : 'bg-white text-slate-500'}`}
                  title="官网首页精选"
                  onClick={() => void toggleFeatured(row)}
                >
                  ★
                </button>
                <button
                  className="h-8 rounded-lg border bg-white px-2.5 text-xs text-slate-600"
                  disabled={busy === `pdf:${row.id}` || row.buildStatus === 'running'}
                  onClick={() => void downloadPdf(row)}
                >
                  PDF
                </button>
                <button
                  className="h-8 px-2 text-xs text-slate-400 hover:text-slate-800"
                  onClick={() => void remove(row)}
                >
                  删除
                </button>
              </div>
            </div>

            {expanded === row.id && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <InsightBlocks blocks={row.blocks} />
                <button
                  className="mt-3 text-xs text-brand-600 hover:underline"
                  onClick={() => setEditing(row.id)}
                >
                  微调标题/摘要 →
                </button>
              </div>
            )}
          </div>
        ))}
        {(list.data ?? []).length === 0 && (
          <div className="card flex flex-col items-center justify-center px-8 py-12 text-center">
            <p className="text-sm text-slate-500">
              还没有洞察报告——在上方选择行业点「AI 生成」,系统会自动聚合该行业的采集数据并由 AI 撰稿成稿
            </p>
          </div>
        )}
      </section>
    </>
  );
}
