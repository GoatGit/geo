'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, useBrandId } from '@/lib/queries';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui';

interface ReputationDto {
  totals: { runs: number; pos: number; neu: number; neg: number; sentimentScore: number | null; hasData: boolean };
  strengths: Array<{ term: string; runs: number; excerpt: string }>;
  weaknesses: Array<{ term: string; runs: number; excerpt: string }>;
  samples: Array<{ runId: number; sentiment: string; excerpt: string | null; engine: string | null; ranAt: string }>;
}

interface RunEvidence {
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

const SENTIMENT_LABEL: Record<string, { label: string; cls: string }> = {
  pos: { label: '正面', cls: 'text-good' },
  neu: { label: '中性', cls: 'text-slate-500' },
  neg: { label: '负面', cls: 'text-bad' },
};

/** 口碑分析(docs/01 §3.6):优势印象 vs 待攻印象 + 原文证据;空态显示引导而非结论(A5 对策)。 */
export default function ReputationPage() {
  const brandId = useBrandId();
  const [evidenceRun, setEvidenceRun] = useState<number | null>(null);
  const evidence = useQuery({
    queryKey: ['run-evidence', evidenceRun],
    queryFn: () => api<RunEvidence>(`/runs/${evidenceRun}/answer`),
    enabled: evidenceRun !== null,
  });
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

      {/* 口碑天平:正负面印象双向发散条形图,视觉呈现口碑天平的倾斜方向 */}
      <section className="card rise-1 p-6">
        <h2 className="mb-1 font-semibold text-slate-900">口碑天平</h2>
        <p className="mb-4 text-xs text-slate-500">
          左侧 = 优势印象（巩固）· 右侧 = 待攻印象（攻坚）· 条长 = 被提及次数
        </p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-0">
          {/* 中轴线 */}
          <div className="col-start-2 row-span-full w-px h-full bg-slate-200" />
          {/* 正面(左半区) */}
          {data.strengths.map((s, i) => (
            <div key={'pos-' + s.term} className={`col-start-1 flex items-center justify-end gap-2 py-1 ${i > 0 ? '-mt-px' : ''}`} style={{ gridRow: i + 1 }}>
              <span className="text-xs font-medium text-slate-700">{s.term}</span>
              <span className="metric-num text-[10px] text-slate-400">{s.runs}</span>
              <div className="h-3.5 rounded-l-full bg-good" style={{ width: `${Math.max(8, (s.runs / Math.max(...data.strengths.map(x => x.runs), 1)) * 100)}px` }} />
            </div>
          ))}
          {/* 负面(右半区) */}
          {data.weaknesses.map((s, i) => (
            <div key={'neg-' + s.term} className={`col-start-3 flex items-center gap-2 py-1`} style={{ gridRow: i + 1 }}>
              <div className="h-3.5 rounded-r-full bg-bad" style={{ width: `${Math.max(8, (s.runs / Math.max(...data.weaknesses.map(x => x.runs), 1)) * 100)}px` }} />
              <span className="text-xs font-medium text-slate-700">{s.term}</span>
              <span className="metric-num text-[10px] text-slate-400">{s.runs}</span>
            </div>
          ))}
          {/* 如果正负面数量不同,行数对齐 */}
          {Array.from({ length: Math.max(data.strengths.length, data.weaknesses.length) }).map((_, i) => (
            <div key={'spacer-' + i} className="col-start-2" style={{ gridRow: i + 1 }} />
          ))}
        </div>
        {data.strengths.length === 0 && data.weaknesses.length === 0 && (
          <p className="text-sm text-slate-400">暂无印象数据</p>
        )}
      </section>

      <section className="card rise-2 p-6">
        <h2 className="mb-3 font-semibold text-slate-900">原文证据</h2>
        <p className="mb-3 text-[11px] text-slate-400">点击任意一条可回溯原始回答与引用存证。</p>
        <ul className="space-y-2">
          {data.samples.map((s, i) => {
            const st = SENTIMENT_LABEL[s.sentiment] ?? { label: s.sentiment, cls: 'text-slate-500' };
            return (
              <li key={i}>
                <button
                  onClick={() => setEvidenceRun(s.runId)}
                  className="w-full rounded border-l-4 border-brand bg-slate-50 px-3 py-2 text-left text-sm transition-colors hover:bg-brand-50"
                >
                  <span className="line-clamp-2">“{s.excerpt ?? '(无摘要)'}”</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                    {s.engine && <span className="rounded bg-white px-1.5 py-0.5 font-medium text-slate-500">{s.engine}</span>}
                    <span className={st.cls}>{st.label}</span>
                    <span className="metric-num">run #{s.runId}</span>
                    <span>{new Date(s.ranAt).toLocaleString('zh-CN')}</span>
                    <span className="text-brand-600">查看原文 →</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[10px] text-slate-400">
          情感判定带置信度,低置信样本自动进入人工抽检池校准(docs/05 §3.2)。
        </p>
      </section>

      {/* 原文证据详情弹窗 */}
      {evidenceRun !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-sm" onClick={() => setEvidenceRun(null)}>
          <div className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
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
                  <button onClick={() => setEvidenceRun(null)} className="shrink-0 text-slate-400 hover:text-slate-700">
                    ✕
                  </button>
                </div>

                <div className="mt-4 whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-4 text-[13px] leading-6 text-slate-700">
                  {evidence.data.answerText || '(空回答)'}
                </div>

                {evidence.data.citations.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-1.5 text-xs font-medium text-slate-500">引用来源({evidence.data.citations.length})</p>
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
      )}
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
