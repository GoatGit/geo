'use client';

import { useQuery } from '@tanstack/react-query';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

interface ReputationDto {
  totals: { runs: number; pos: number; neu: number; neg: number; sentimentScore: number | null; hasData: boolean };
  strengths: Array<{ term: string; runs: number; excerpts: string[] }>;
  weaknesses: Array<{ term: string; runs: number; excerpts: string[] }>;
  samples: Array<{ runId: number; sentiment: string; excerpt: string | null; ranAt: string }>;
}

/** 口碑分析(docs/01 §3.6):优势印象 vs 待攻印象 + 原文证据;空态显示引导而非结论(A5 对策)。 */
export default function ReputationPage() {
  const brandId = useBrandId();
  const { data, isLoading } = useQuery({
    queryKey: ['reputation', brandId],
    queryFn: () => api<ReputationDto>(`/monitor/reputation?brand=${brandId}&days=7`),
    enabled: !!brandId,
  });

  if (isLoading) return <Skeleton />;
  if (!data || !data.totals.hasData)
    return (
      <EmptyState text="暂无口碑数据:在「监控问题」添加口碑词类型的问题(如「XX的口碑怎么样?」),采集完成后此处展示" />
    );

  return (
    <div className="space-y-6">
      <PageHeader title="口碑分析" />

      <section className="grid gap-4 lg:grid-cols-2 rise-1">
        <div className="card p-6">
          <h2 className="mb-3 font-semibold text-good">优势印象 · 巩固</h2>
          <ul className="space-y-1.5 text-sm">
            {data.strengths.map((s) => (
              <li key={s.term} className="flex justify-between" title={s.excerpts[0]}>
                <span>{s.term}</span>
                <span className="metric-num text-slate-400">{s.runs}</span>
              </li>
            ))}
            {data.strengths.length === 0 && <li className="text-slate-400">暂无</li>}
          </ul>
        </div>
        <div className="card p-6">
          <h2 className="mb-3 font-semibold text-warn">待攻印象 · 攻坚</h2>
          <ul className="space-y-1.5 text-sm">
            {data.weaknesses.map((s) => (
              <li key={s.term} className="flex justify-between" title={s.excerpts[0]}>
                <span>{s.term}</span>
                <span className="metric-num text-slate-400">{s.runs}</span>
              </li>
            ))}
            {data.weaknesses.length === 0 && <li className="text-slate-400">暂无</li>}
          </ul>
        </div>
      </section>

      <section className="card rise-2 p-6">
        <h2 className="mb-3 font-semibold text-slate-900">原文证据</h2>
        <ul className="space-y-2">
          {data.samples.map((s, i) => (
            <li key={i} className="rounded border-l-4 border-brand bg-slate-50 px-3 py-2 text-sm">
              “{s.excerpt ?? '(无摘要)'}”
              <span className="ml-2 text-[10px] text-slate-400">
                run #{s.runId} · {s.sentiment} · {new Date(s.ranAt).toLocaleString('zh-CN')}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-slate-400">
          情感判定带置信度,低置信样本自动进入人工抽检池校准(docs/05 §3.2)。
        </p>
      </section>
    </div>
  );
}
