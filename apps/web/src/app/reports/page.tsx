'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, brandStore } from '@/lib/queries';
import { PageHeader, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';

interface ReportRow {
  id: number;
  type: string;
  period: string;
  status: string;
  payloadRef: string | null;
  createdAt: string;
}

interface TemplateDto {
  type: string;
  name: string;
  desc: string;
  sections: string[];
}

const TYPE_LABEL: Record<string, string> = { weekly: '周报', monthly: '月报', diagnostic: '体检' };
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'bg-good-50 text-good' },
  generating: { label: '生成中', cls: 'bg-brand-50 text-brand-700' },
  queued: { label: '排队中', cls: 'bg-slate-100 text-slate-500' },
  failed: { label: '失败', cls: 'bg-bad-50 text-bad' },
};

/** 报告中心(docs/01 §3.8):列表 + 在线预览 + 下载 + 模板说明;周报每周一自动生成。 */
export default function ReportsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const brandId = brandStore.get();
  const reports = useQuery({ queryKey: ['reports', brandId], queryFn: () => api<ReportRow[]>('/reports') });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<TemplateDto[]>('/reports/templates') });

  const generate = useMutation({
    mutationFn: (type: string) => api('/reports/generate', { method: 'POST', json: { brandId, type } }),
    onSuccess: () => {
      toast('报告已加入生成队列');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });
  const retry = useMutation({
    mutationFn: (id: number) => api(`/reports/${id}/retry`, { method: 'POST', json: {} }),
    onSuccess: () => {
      toast('已重新排队');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast((e as Error).message, 'err'),
  });

  const [preview, setPreview] = useState<{ id: number; html: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState<number | null>(null);

  const openPreview = async (id: number) => {
    setPreviewBusy(id);
    try {
      const r = await api<{ html: string }>(`/reports/${id}/preview`);
      setPreview({ id, html: r.html });
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setPreviewBusy(null);
    }
  };

  const download = async (id: number) => {
    try {
      const r = await api<{ filename: string; contentBase64: string }>(`/reports/${id}/download`);
      const a = document.createElement('a');
      a.href = `data:text/html;charset=utf-8;base64,${r.contentBase64}`;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已开始下载(浏览器打印即可另存为 PDF)');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  if (!brandId) return <Skeleton />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="报告中心"
        actions={
          <>
            <button className="btn-ghost" disabled={generate.isPending} onClick={() => generate.mutate('weekly')}>
              {generate.isPending ? '提交中…' : '生成周报'}
            </button>
            <button className="btn-primary" disabled={generate.isPending} onClick={() => generate.mutate('monthly')}>
              {generate.isPending ? '提交中…' : '生成月报'}
            </button>
          </>
        }
      />

      {/* 报告模板说明 */}
      <section className="rise grid gap-4 md:grid-cols-3">
        {(templates.data ?? []).map((t) => (
          <div key={t.type} className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{t.name}</h3>
              <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-700">
                {TYPE_LABEL[t.type] ?? t.type}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">{t.desc}</p>
          </div>
        ))}
        {templates.isLoading && <div className="h-20 animate-pulse rounded-xl bg-slate-100" />}
      </section>

      {/* 列表 */}
      <section className="table-wrap rise-1">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">周期</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">生成时间</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(reports.data ?? []).map((r) => {
              const st = STATUS_LABEL[r.status] ?? { label: r.status, cls: 'bg-slate-100' };
              const canUse = r.status === 'done';
              return (
                <tr key={r.id} className="table-row">
                  <td className="px-4 py-3">{TYPE_LABEL[r.type] ?? r.type}</td>
                  <td className="metric-num px-4 py-3">{r.period}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2 text-xs">
                      {canUse && (
                        <button
                          className="rounded border border-slate-200 px-2.5 py-1 transition-colors hover:border-brand-300 hover:text-brand-700"
                          disabled={previewBusy === r.id}
                          onClick={() => openPreview(r.id)}
                        >
                          {previewBusy === r.id ? '加载中…' : '预览'}
                        </button>
                      )}
                      {canUse && (
                        <button className="rounded border border-slate-200 px-2.5 py-1 transition-colors hover:border-brand-300 hover:text-brand-700" onClick={() => download(r.id)}>
                          下载
                        </button>
                      )}
                      {!canUse && r.status !== 'generating' && (
                        <button
                          className="rounded border border-slate-200 px-2.5 py-1 transition-colors hover:border-brand-300 hover:text-brand-700"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(r.id)}
                        >
                          重试
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {(reports.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  首份报告将在首轮采集完成后可生成
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* 预览模态(iframe 隔离报告样式) */}
      {preview && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/60 p-4 md:p-10"
          onClick={() => setPreview(null)}
        >
          <div
            className="animate-fade-up flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <span className="text-sm font-semibold text-slate-800">
                报告预览 #{preview.id}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  打印时选择「另存为 PDF」即可获得 PDF 版本
                </span>
              </span>
              <div className="flex items-center gap-2">
                <button className="btn-ghost" onClick={() => download(preview.id)}>
                  下载
                </button>
                <button className="btn-primary" onClick={() => setPreview(null)}>
                  关闭
                </button>
              </div>
            </div>
            <iframe title={`报告 ${preview.id}`} srcDoc={preview.html} sandbox="allow-popups allow-modals" className="h-full w-full flex-1 bg-slate-100" />
          </div>
        </div>
      )}
    </div>
  );
}
