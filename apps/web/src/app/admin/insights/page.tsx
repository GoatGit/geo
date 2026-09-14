'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { INSIGHT_BLOCK_TYPES, type InsightBlock } from '@geo/shared';

/**
 * 平台后台 · 行业洞察(docs/01 §3.10 扩展):
 * 行业配置(增/停用)+ 洞察报告 CRUD;blocks 以 JSON 编辑(结构校验前后端各一道)。
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
  const industries = useQuery({ queryKey: ['admin-insight-industries'], queryFn: () => api<IndustryRow[]>('/admin/insights/industries') });
  const list = useQuery({ queryKey: ['admin-insights'], queryFn: () => api<AdminInsightDto[]>('/admin/insights') });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [newIndustry, setNewIndustry] = useState('');
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

  const toggleIndustry = async (row: IndustryRow) => {
    await api(`/admin/insights/industries/${row.id}`, { method: 'PATCH', json: { active: !row.active } });
    refresh();
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
        desc="配置洞察行业与报告内容;已发布报告进入会员总览,精选报告在官网首页展示。"
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
        <h2 className="mb-3 font-semibold text-slate-900">洞察行业</h2>
        <div className="mb-3 flex gap-2">
          <input
            value={newIndustry}
            onChange={(e) => setNewIndustry(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addIndustry()}
            placeholder="新增行业,如:内衣 / 服饰运动 / 美妆护肤"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <button onClick={addIndustry} className="btn-ghost">添加</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {(industries.data ?? []).map((i) => (
            <button
              key={i.id}
              onClick={() => toggleIndustry(i)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                i.active ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through'
              }`}
              title={i.active ? '点击停用' : '点击启用'}
            >
              {i.name}
            </button>
          ))}
          {(industries.data ?? []).length === 0 && <p className="text-xs text-slate-400">还没有行业:先添加行业再建报告。</p>}
        </div>
      </section>

      {/* 报告列表 */}
      <section className="card mt-4 p-6">
        <h2 className="mb-3 font-semibold text-slate-900">洞察报告</h2>
        {(list.data ?? []).length === 0 ? (
          <EmptyState text="还没有洞察报告:添加行业后点「新建洞察报告」。" />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400">
                <th className="py-2 font-medium">标题</th>
                <th className="py-2 font-medium">行业</th>
                <th className="py-2 font-medium">状态</th>
                <th className="py-2 font-medium">首页精选</th>
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
                  <td className="py-2.5">
                    <button onClick={() => toggleField(r, 'status')}>
                      <Badge label={r.status === 'published' ? '已发布' : '草稿'} tone={r.status === 'published' ? 'good' : 'slate'} />
                    </button>
                  </td>
                  <td className="py-2.5">
                    <button onClick={() => toggleField(r, 'featured')}>
                      <Badge label={r.featured ? '精选' : '—'} tone={r.featured ? 'brand' : 'slate'} />
                    </button>
                  </td>
                  <td className="py-2.5 text-right text-xs">
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
        <p className="mt-3 text-[10px] text-slate-400">内容块类型:{INSIGHT_BLOCK_TYPES.join(' / ')} —— 结构口径见 @geo/shared/insights。</p>
      </section>
    </>
  );
}
