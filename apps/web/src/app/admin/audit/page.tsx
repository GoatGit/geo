'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';
import { PageHeader, Skeleton } from '@/components/ui';

/**
 * 平台后台 · 口碑抽检(docs/14 §25):低置信 LLM 判定的人工审核闭环——
 * pending 池只进不出的问题修复。审核动作:确认原判 / 纠正三分类;
 * 纠正写回 reputation_facts(audit_state=audited,confidence=1)。
 */

interface AuditRow {
  id: number;
  brand_id: number;
  brand_name: string;
  engine: string | null;
  ran_at: string;
  sentiment: 'pos' | 'neu' | 'neg';
  confidence: number;
  impression_terms: Array<{ term: string; polarity: string; excerpt: string }>;
  excerpt: string | null;
  audit_state: string;
}

const SENT_TONE: Record<string, string> = {
  pos: 'bg-good-50 text-good',
  neu: 'bg-slate-100 text-slate-600',
  neg: 'bg-bad-50 text-bad',
};
const SENT_LABEL: Record<string, string> = { pos: '正面', neu: '中性', neg: '负面' };

export default function ReputationAuditPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'audited'>('pending');
  const list = useQuery({
    queryKey: ['rep-audit', status],
    queryFn: () => api<{ items: AuditRow[] }>(`/admin/reputation-audit?status=${status}`),
  });

  const act = async (id: number, body: { sentiment?: 'pos' | 'neu' | 'neg'; keep?: boolean }) => {
    try {
      await api(`/admin/reputation-audit/${id}`, { method: 'PATCH', json: body });
      void queryClient.invalidateQueries({ queryKey: ['rep-audit'] });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  if (list.isLoading) return <Skeleton />;
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="口碑抽检"
        desc="低置信 LLM 判定的人工审核:确认原判或纠正三分类——纠正会写回口碑事实并影响口碑分析口径。"
        actions={
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(['pending', 'audited'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  status === s ? 'bg-brand-600 text-white' : 'text-slate-500'
                }`}
              >
                {s === 'pending' ? '待审核' : '已审核'}
              </button>
            ))}
          </div>
        }
      />

      <div className="mt-4 space-y-3">
        {items.map((r) => (
          <div key={r.id} className="card p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="rounded bg-slate-100 px-1.5 py-0.5">{r.brand_name}</span>
              {r.engine && <span className="rounded bg-slate-100 px-1.5 py-0.5">{r.engine}</span>}
              <span className="metric-num">#{r.id}</span>
              <span>{new Date(r.ran_at).toLocaleString('zh-CN')}</span>
              <span className="metric-num rounded bg-warn-50 px-1.5 py-0.5 text-warn" title="LLM 判定置信度">
                置信 {Math.round(r.confidence * 100)}%
              </span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${SENT_TONE[r.sentiment]}`}>
                判定:{SENT_LABEL[r.sentiment]}
              </span>
            </div>
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
              “{r.excerpt ?? '(无摘要)'}”
            </p>
            {r.impression_terms?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.impression_terms.map((t, i) => (
                  <span
                    key={i}
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      t.polarity === 'pos' ? 'bg-good-50 text-good' : t.polarity === 'neg' ? 'bg-bad-50 text-bad' : 'bg-slate-100 text-slate-500'
                    }`}
                    title={t.excerpt}
                  >
                    {t.term}
                  </span>
                ))}
              </div>
            )}
            {status === 'pending' && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="h-8 rounded-lg bg-brand px-3 text-xs font-semibold text-white" onClick={() => void act(r.id, { keep: true })}>
                  ✓ 确认原判
                </button>
                <span className="flex items-center gap-1.5 text-xs text-slate-400">纠正为:</span>
                {(['pos', 'neu', 'neg'] as const).map((s) => (
                  <button
                    key={s}
                    disabled={s === r.sentiment}
                    className={`h-8 rounded-lg border px-3 text-xs font-medium disabled:opacity-30 ${SENT_TONE[s]}`}
                    onClick={() => void act(r.id, { sentiment: s })}
                  >
                    {SENT_LABEL[s]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="card px-8 py-12 text-center text-sm text-slate-400">
            {status === 'pending' ? '没有待审核样本——低置信判定出现时会进入这里' : '还没有已审核记录'}
          </div>
        )}
      </div>
    </>
  );
}
