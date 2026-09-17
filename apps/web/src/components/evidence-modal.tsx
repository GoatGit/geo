'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * AI 回答快照弹窗(证据链回溯,docs/01 §3.7):
 * 矩阵单元格 / 口碑证据卡等点击后展示原始回答全文、引用来源与完整性哈希。
 */

export interface RunEvidence {
  runId: number;
  status: string;
  engine: string;
  ranAt: string;
  question: string | null;
  answerText: string;
  citations: Array<{ url: string; title?: string }>;
  manifestHash: string | null;
  answerRef: string | null;
}

export function EvidenceModal({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const evidence = useQuery({
    queryKey: ['run-evidence', runId],
    queryFn: () => api<RunEvidence>(`/runs/${runId}/answer`),
    enabled: runId !== null,
  });

  if (runId === null) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {evidence.isLoading || !evidence.data ? (
          <p className="py-10 text-center text-sm text-slate-400">正在调取存证…</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] text-slate-400">
                  run #{evidence.data.runId} · {evidence.data.engine} ·{' '}
                  {new Date(evidence.data.ranAt).toLocaleString('zh-CN')}
                </p>
                <h3 className="mt-1 text-[15px] font-semibold leading-6 text-slate-900">
                  {evidence.data.question ?? '(问题缺失)'}
                </h3>
              </div>
              <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-700">
                ✕
              </button>
            </div>

            <div className="mt-4 whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-4 text-[13px] leading-6 text-slate-700">
              {evidence.data.answerText || '(空回答)'}
            </div>

            {evidence.data.citations.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-xs font-medium text-slate-500">
                  引用来源({evidence.data.citations.length})
                </p>
                <ul className="space-y-1">
                  {evidence.data.citations.map((c, i) => (
                    <li key={i} className="truncate text-xs">
                      <a href={c.url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                        {c.title || c.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="metric-num mt-4 break-all border-t border-slate-100 pt-3 text-[10px] text-slate-400">
              存证 {evidence.data.answerRef} · 完整性 {evidence.data.manifestHash ?? '—'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
