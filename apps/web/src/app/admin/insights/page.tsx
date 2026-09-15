'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { api, apiDownload } from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { INSIGHT_BLOCK_TYPES, INSIGHT_WINDOW_CHOICES, type InsightBlock, type InsightBuildStatus } from '@geo/shared';

/**
 * 平台后台 · 行业洞察(docs/01 §3.10 扩展):
 * 行业配置(增/删/停用)+ 洞察报告「运行」(worker 按行业聚合采集数据自动成稿)
 * + 手工微调 blocks JSON + 发布/精选 + PDF 下载。
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

interface EditorState {
  id: number | null;
  industryId: number | '';
  issue: string;
  title: string;
  summary: string;
  headline: string;
  brands: string;
  questions: string;
  answers: string;
  testedAt: string;
  blocksText: string;
  status: 'draft' | 'published';
  featured: boolean;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  industryId: '',
  issue: '',
  title: '',
  summary: '',
  headline: '',
  brands: '',
  questions: '',
  answers: '',
  testedAt: '',
  blocksText: JSON.stringify(
    [
      { type: 'takeaway', title: '一句话', text: '……' },
      { type: 'barRank', title: '品牌命中排行', note: '命中率 = 被主动提及次数 ÷ 总题数', total: 78, items: [{ name: '品牌A', value: 50 }] },
    ],
    null,
    2,
  ),
  status: 'draft',
  featured: false,
};

export default function AdminInsightsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const industries = useQuery({ queryKey: ['admin-insight-industries'], queryFn: () => api<IndustryRow[]>('/admin/insights/industries') });
  const list = useQuery({
    queryKey: ['admin-insights'],
    queryFn: () => api<AdminInsightDto[]>('/admin/insights'),
    // 有运行中的聚合时轮询,直到回写完成
    refetchInterval: (q) =>
      ((q.state.data ?? []) as AdminInsightDto[]).some((r) => r.buildStatus === 'running') ? 2500 : false,
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [newIndustry, setNewIndustry] = useState('');
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [busyId, setBusyId] = useState<number | 'industry' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-insights'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-insight-industries'] });
  };

  const addIndustry = async () => {
    if (!newIndustry.trim()) return;
    try {
      await api('/admin/insights/industries', { method: 'POST', json: { name: newIndustry.trim() } });
      setNewIndustry('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
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

  /** 运行行业洞察:对该行业最新一期报告(无则自动创建)触发数据聚合。 */
  const runInsight = async (row: AdminInsightDto) => {
    const industry = (industries.data ?? []).find((i) => i.name === row.industry);
    if (!industry) {
      setError('找不到行业配置');
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      await api(`/admin/insights/industries/${industry.id}/run`, {
        method: 'POST',
        json: windowDays ? { windowDays } : {},
      });
      toast(`已开始聚合「${row.industry}」${windowDays ? `近 ${windowDays} 天` : '全量'}数据,完成后自动刷新`);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusyId(null);
    }
  };

  const downloadPdf = async (row: AdminInsightDto) => {
    setBusyId(row.id);
    setError(null);
    try {
      await apiDownload(`/admin/insights/${row.id}/pdf`, `insight-${row.id}.pdf`);
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusyId(null);
    }
  };

  const openEditor = async (row?: AdminInsightDto) => {
    setError(null);
    if (!row) {
      setEditor({ ...EMPTY_EDITOR });
      return;
    }
    const detail = await api<AdminInsightDto>(`/admin/insights/${row.id}`);
    const cover = (detail.cover ?? {}) as Record<string, unknown>;
    setEditor({
      id: detail.id,
      industryId: industries.data?.find((i) => i.name === detail.industry)?.id ?? '',
      issue: detail.issue,
      title: detail.title,
      summary: detail.summary,
      headline: String(cover.headline ?? ''),
      brands: String(cover.brands ?? ''),
      questions: String(cover.questions ?? ''),
      answers: String(cover.answers ?? ''),
      testedAt: String(cover.testedAt ?? ''),
      blocksText: JSON.stringify(detail.blocks, null, 2),
      status: detail.status,
      featured: detail.featured,
    });
  };

  const save = async () => {
    if (!editor) return;
    setError(null);
    let blocks: unknown;
    try {
      blocks = JSON.parse(editor.blocksText);
    } catch {
      setError('blocks 不是合法 JSON');
      return;
    }
    const json = {
      industryId: Number(editor.industryId),
      issue: editor.issue,
      title: editor.title,
      summary: editor.summary,
      cover: {
        ...(editor.headline ? { headline: editor.headline } : {}),
        ...(editor.brands ? { brands: Number(editor.brands) } : {}),
        ...(editor.questions ? { questions: Number(editor.questions) } : {}),
        ...(editor.answers ? { answers: Number(editor.answers) } : {}),
        ...(editor.testedAt ? { testedAt: editor.testedAt } : {}),
      },
      blocks,
      status: editor.status,
      featured: editor.featured,
    };
    try {
      if (editor.id) await api(`/admin/insights/${editor.id}`, { method: 'PATCH', json });
      else await api('/admin/insights', { method: 'POST', json });
      setEditor(null);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (row: AdminInsightDto) => {
    await api(`/admin/insights/${row.id}`, { method: 'DELETE' });
    refresh();
  };

  const toggleField = async (row: AdminInsightDto, field: 'status' | 'featured') => {
    await api(`/admin/insights/${row.id}`, { method: 'PATCH', json: { [field]: field === 'status' ? (row.status === 'published' ? 'draft' : 'published') : !row.featured } });
    refresh();
  };

  if (industries.isLoading || list.isLoading) return <Skeleton />;

  return (
    <>
      <PageHeader
        title="行业洞察"
        desc="配置行业 → 运行聚合自动成稿 → 微调发布 → 下载 PDF;已发布进入会员总览,精选上官网首页。"
        actions={
          <button onClick={() => openEditor()} className="btn-primary" disabled={(industries.data ?? []).length === 0}>
            新建洞察报告
          </button>
        }
      />

      {error && <p className="mt-4 rounded-lg bg-bad-50 px-3.5 py-2.5 text-xs text-bad">{error}</p>}

      {/* 编辑器 */}
      {editor && (
        <div className="card mt-4 space-y-3 p-6">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium text-slate-500">
              所属行业 *
              <select
                value={editor.industryId}
                onChange={(e) => setEditor({ ...editor, industryId: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <option value="">选择行业…</option>
                {(industries.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-500">
              期数
              <input value={editor.issue} onChange={(e) => setEditor({ ...editor, issue: e.target.value })} placeholder="第 1 期" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700" />
            </label>
          </div>
          <label className="block text-xs font-medium text-slate-500">
            标题 *
            <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="国产内衣 AI 可见度榜" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700" />
          </label>
          <label className="block text-xs font-medium text-slate-500">
            摘要
            <textarea value={editor.summary} onChange={(e) => setEditor({ ...editor, summary: e.target.value })} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700" />
          </label>
          <fieldset className="rounded-lg border border-slate-100 p-3">
            <legend className="px-1 text-xs font-medium text-slate-500">封面指标(列表卡展示)</legend>
            <div className="grid gap-2 md:grid-cols-5">
              <input value={editor.headline} onChange={(e) => setEditor({ ...editor, headline: e.target.value })} placeholder=" headline" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs" />
              <input value={editor.brands} onChange={(e) => setEditor({ ...editor, brands: e.target.value })} placeholder="品牌数" type="number" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs" />
              <input value={editor.questions} onChange={(e) => setEditor({ ...editor, questions: e.target.value })} placeholder="题数" type="number" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs" />
              <input value={editor.answers} onChange={(e) => setEditor({ ...editor, answers: e.target.value })} placeholder="回答数" type="number" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs" />
              <input value={editor.testedAt} onChange={(e) => setEditor({ ...editor, testedAt: e.target.value })} placeholder="2026-09-02" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs" />
            </div>
          </fieldset>
          <label className="block text-xs font-medium text-slate-500">
            内容块 JSON(blocks;类型:takeaway / barRank / funnel / heatmap / radar / scatter)
            <textarea
              value={editor.blocksText}
              onChange={(e) => setEditor({ ...editor, blocksText: e.target.value })}
              rows={14}
              className="metric-num mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs leading-5 text-slate-700"
            />
          </label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <input type="checkbox" checked={editor.status === 'published'} onChange={(e) => setEditor({ ...editor, status: e.target.checked ? 'published' : 'draft' })} />
              发布
            </label>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <input type="checkbox" checked={editor.featured} onChange={(e) => setEditor({ ...editor, featured: e.target.checked })} />
              官网首页精选
            </label>
            <div className="ml-auto flex gap-2">
              <button onClick={() => setEditor(null)} className="btn-ghost">取消</button>
              <button onClick={save} className="btn-primary">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 行业配置 */}
      <section className="card mt-4 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">洞察行业</h2>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            运行数据窗口
            <select
              value={windowDays ?? ''}
              onChange={(e) => setWindowDays(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            >
              {INSIGHT_WINDOW_CHOICES.map((d) => (
                <option key={d} value={d}>近 {d} 天</option>
              ))}
              <option value="">全量历史</option>
            </select>
          </label>
        </div>
        <div className="mb-3 flex gap-2">
          <input
            value={newIndustry}
            onChange={(e) => setNewIndustry(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addIndustry()}
            placeholder="新增行业,如:新能源汽车 / 内衣 / 美妆护肤"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <button onClick={addIndustry} className="btn-ghost">添加</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(industries.data ?? []).map((i) => (
            <span
              key={i.id}
              className={`group inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                i.active ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through'
              }`}
            >
              <button onClick={() => toggleIndustry(i)} title={i.active ? '点击停用' : '点击启用'}>
                {i.name}
              </button>
              <button
                onClick={() => removeIndustry(i)}
                className="text-slate-300 transition-colors hover:text-bad group-hover:text-slate-400"
                title="删除行业"
              >
                ×
              </button>
            </span>
          ))}
          {(industries.data ?? []).length === 0 && <p className="text-xs text-slate-400">还没有行业:先添加行业再运行洞察。</p>}
        </div>
      </section>

      {/* 报告列表 */}
      <section className="card mt-4 p-6">
        <h2 className="mb-3 font-semibold text-slate-900">洞察报告</h2>
        {(list.data ?? []).length === 0 ? (
          <EmptyState text="还没有洞察报告:添加行业后,在对应行业的报告上点「运行」自动生成数据报告。" />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400">
                <th className="py-2 font-medium">标题</th>
                <th className="py-2 font-medium">行业</th>
                <th className="py-2 font-medium">数据</th>
                <th className="py-2 font-medium">状态</th>
                <th className="py-2 font-medium">精选</th>
                <th className="py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="border-b border-slate-50 text-slate-600">
                  <td className="py-2.5">
                    <span className="font-medium text-slate-800">{r.title}</span>
                    {r.issue && <span className="ml-2 text-xs text-slate-400">{r.issue}</span>}
                  </td>
                  <td className="py-2.5">{r.industry}</td>
                  <td className="py-2.5 text-xs text-slate-400">
                    {r.builtAt ? (
                      `${r.windowDays ? `近${r.windowDays}天` : '全量'} · ${new Date(r.builtAt).toLocaleDateString('zh-CN')}`
                    ) : (
                      '未运行'
                    )}
                  </td>
                  <td className="py-2.5">
                    <button onClick={() => toggleField(r, 'status')}>
                      <Badge label={r.status === 'published' ? '已发布' : '草稿'} tone={r.status === 'published' ? 'good' : 'slate'} />
                    </button>
                    {r.buildStatus === 'running' && <span className="ml-1.5"><Badge label="聚合中…" tone="brand" /></span>}
                    {r.buildStatus === 'failed' && (
                      <span className="ml-1.5" title={r.buildError ?? '聚合失败'}>
                        <Badge label="运行失败" tone="bad" />
                      </span>
                    )}
                  </td>
                  <td className="py-2.5">
                    <button onClick={() => toggleField(r, 'featured')}>
                      <Badge label={r.featured ? '精选' : '—'} tone={r.featured ? 'brand' : 'slate'} />
                    </button>
                  </td>
                  <td className="py-2.5 text-right text-xs">
                    <button
                      onClick={() => runInsight(r)}
                      disabled={r.buildStatus === 'running' || busyId === r.id}
                      className="mr-3 font-medium text-brand-600 hover:underline disabled:opacity-40"
                    >
                      运行
                    </button>
                    <button
                      onClick={() => downloadPdf(r)}
                      disabled={busyId === r.id}
                      className="mr-3 text-slate-500 hover:text-slate-800 disabled:opacity-40"
                    >
                      PDF
                    </button>
                    {r.status === 'published' && (
                      <Link href={`/insights/${r.id}`} className="mr-3 text-brand-600 hover:underline" target="_blank">
                        预览
                      </Link>
                    )}
                    <button onClick={() => openEditor(r)} className="mr-3 text-slate-500 hover:text-slate-800">编辑</button>
                    <button onClick={() => remove(r)} className="text-bad hover:underline">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="mt-3 text-[10px] leading-5 text-slate-400">
          「运行」按行业聚合全部监测品牌的采集事实,自动生成/覆盖报告内容(含已发布报告)——发布态与精选标记保持不变;
          聚合由 worker 队列执行,几秒内完成,期间不可重复触发或下载。内容块类型:{INSIGHT_BLOCK_TYPES.join(' / ')}。
        </p>
      </section>
    </>
  );
}
