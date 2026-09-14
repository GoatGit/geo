'use client';

import { useQuery } from '@tanstack/react-query';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

interface ReputationDto {
  totals: { runs: number; pos: number; neu: number; neg: number; sentimentScore: number | null; hasData: boolean };
  strengths: Array<{ term: string; runs: number; excerpt: string }>;
  weaknesses: Array<{ term: string; runs: number; excerpt: string }>;
  samples: Array<{ runId: number; sentiment: string; excerpt: string | null; ranAt: string }>;
}

/** 口碑分析(docs/01 §3.6):优势印象 vs 待攻印象 + 原文证据;空态显示引导而非结论(A5 对策)。 */
export default function ReputationPage() {
  const brandId = useBrandId();
  const { data, isLoading, error } = useQuery({
    queryKey: ['reputation', brandId],
    queryFn: () => api<ReputationDto>(`/monitor/reputation?brand=${brandId}&days=7`),
    enabled: !!brandId,
  });

  if (isLoading) return <Skeleton />;
  if (error) {
    return <EmptyState title="数据加载失败" text={`${(error as Error).message} —— 请稍后重试,或在顶栏切换品牌。`} />;
  }
  if (!data || !data.totals.hasData)
    return (
      <EmptyState text="暂无口碑数据:在「监控问题」添加口碑词类型的问题(如「XX的口碑怎么样?」),采集完成后此处展示" />
    );

  return (
    <div className="space-y-6">
      <PageHeader title="口碑分析" />

      <div className="card rise flex items-center gap-8 p-6">
        <ScoreRing value={data.totals.sentimentScore} />
        <div>
          <h2 className="font-semibold text-slate-900">情绪得分</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            口碑词有效回答 <b className="metric-num text-slate-700">{data.totals.runs}</b> 条 ·
            正面 <b className="metric-num text-good">{data.totals.pos}</b> / 中性{' '}
            <b className="metric-num text-slate-700">{data.totals.neu}</b> / 负面{' '}
            <b className="metric-num text-bad">{data.totals.neg}</b>
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            得分 = round(正面数 / 有效数 × 100),口径见 docs/02 §4;低置信判定已进入人工抽检池。
          </p>
        </div>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-6">
          <h2 className="mb-3 font-semibold text-good">优势印象 · 巩固</h2>
          <ul className="space-y-1.5 text-sm">
            {data.strengths.map((s) => (
              <li key={s.term} className="flex justify-between" title={s.excerpt}>
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
              <li key={s.term} className="flex justify-between" title={s.excerpt}>
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

function ScoreRing({ value }: { value: number | null }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  return (
    <svg width="112" height="112" viewBox="0 0 100 100" className="shrink-0">
      <defs>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#93a492" />
          <stop offset="1" stopColor="#5c675b" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r={r} fill="none" stroke="#e7ebe4" strokeWidth="9" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="url(#ring)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v / 100)}
        transform="rotate(-90 50 50)"
        className="transition-all duration-700"
      />
      <text x="50" y="57" textAnchor="middle" fontSize="21" fontWeight="600" fill="#3f453e" className="metric-num">
        {value ?? '—'}
      </text>
    </svg>
  );
}
