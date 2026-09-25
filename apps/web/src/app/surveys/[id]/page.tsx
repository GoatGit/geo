'use client';
import Link from 'next/link';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { validateSurveyQuestions, validateSurveySegments } from '@geo/shared';
import { api } from '@/lib/api';
import { PageHeader, Skeleton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { SurveyBack, SurveyError, SurveyStatus, SyntheticNote } from '@/components/surveys/common';
import { QuestionEditor, SegmentEditor, DEFAULT_SEGMENT } from '@/components/surveys/editors';
import { PersonaBrowser } from '@/components/surveys/persona-browser';
import { busySurvey, type SurveyDetail, type SurveyQuestion, type SurveySegment } from '@/components/surveys/types';

export default function SurveyDetailPage() { return <Suspense fallback={<Skeleton />}><SurveyDetailContent /></Suspense>; }
function SurveyDetailContent() {
  const params = useParams<{ id: string }>(), sp = useSearchParams(), router = useRouter();
  const id = Number(params.id), cache = useQueryClient(), toast = useToast();
  const survey = useQuery({ queryKey: ['survey', id], queryFn: () => api<SurveyDetail>(`/surveys/${id}`), refetchInterval: q => busySurvey(q.state.data?.status ?? '') ? 2000 : false });
  const [sourceMode, setSourceMode] = useState<string | null>(null);
  const [questionDraft, setQuestionDraft] = useState<SurveyQuestion[] | null>(null), [segmentDraft, setSegmentDraft] = useState<SurveySegment[] | null>(null);
  const data = survey.data;
  const questionDirty = questionDraft !== null, segmentDirty = segmentDraft !== null || sourceMode !== null;
  useEffect(() => { setQuestionDraft(null); setSegmentDraft(null); setSourceMode(null); }, [id]);
  useEffect(() => {
    if (!questionDirty && !segmentDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const guardLink = (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || link.target === '_blank' || link.href === window.location.href) return;
      if (!window.confirm('有未保存的修改，离开将丢弃修改。继续吗？')) { event.preventDefault(); event.stopPropagation(); }
      else { setQuestionDraft(null); setSegmentDraft(null); setSourceMode(null); }
    };
    window.addEventListener('beforeunload', warn); document.addEventListener('click', guardLink, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', guardLink, true); };
  }, [questionDirty, segmentDirty]);
  const refresh = async () => { await cache.invalidateQueries({ queryKey: ['survey', id] }); void cache.invalidateQueries({ queryKey: ['surveys'] }); void cache.invalidateQueries({ queryKey: ['survey-pools'] }); };
  const action = useMutation({ mutationFn: ({ path, json }: { path: string; json?: unknown }) => api(path, { method: 'POST', json }), onMutate: (): void => { saveQuestions.reset(); savePool.reset(); }, onSuccess: refresh });
  const saveQuestions = useMutation({ mutationFn: (questions: SurveyQuestion[]) => api(`/surveys/${id}/questions`, { method: 'POST', json: { questions } }), onMutate: (): void => { action.reset(); savePool.reset(); }, onSuccess: async () => { await refresh(); setQuestionDraft(null); toast('问卷已保存'); router.replace(`/surveys/${id}?step=audience`); } });
  const savePool = useMutation({ mutationFn: (segments: SurveySegment[]) => api(`/surveys/${id}/pools`, { method: 'POST', json: { segments, sourceMode: sourceMode ?? data?.pool?.sourceMode ?? 'generated' } }), onMutate: (): void => { action.reset(); saveQuestions.reset(); }, onSuccess: async () => { await refresh(); setSegmentDraft(null); setSourceMode(null); toast('人群已保存，请确认后开始作答'); } });
  if (survey.isPending) return <Skeleton />;
  if (survey.error || !data) return <SurveyError error={survey.error ?? new Error('调研不存在')} retry={() => void survey.refetch()} />;
  const questions = questionDraft ?? data.questions;
  const segments = segmentDraft ?? data.pool?.spec.segments ?? (data.suggestedSegments.length ? data.suggestedSegments : [DEFAULT_SEGMENT]);
  const busy = busySurvey(data.status), locked = !data.editable, pending = action.isPending || saveQuestions.isPending || savePool.isPending;
  const defaultStep = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'].includes(data.status) && data.pool ? 'run' : 'questions';
  const requestedStep = sp.get('step');
  const step = busy ? data.status === 'generating' ? 'questions' : 'run' : ['questions', 'audience', 'run'].includes(requestedStep ?? '') ? requestedStep! : defaultStep;
  const steps = [['questions', '审阅问卷'], ['audience', '选择人群'], ['run', '运行与结果']];
  const completed = data.progress.completed, failed = data.progress.failed, total = data.progress.total;
  const percent = total ? Math.min(100, Math.round((completed + failed) / total * 100)) : 0;
  const runReady = Boolean(data.pool?.approved) && !questionDirty && !segmentDirty && !busy && data.status !== 'completed';
  const error = action.error ?? saveQuestions.error ?? savePool.error;
  const navigate = (to: string) => { if ((questionDirty || segmentDirty) && !window.confirm('有未保存的修改，离开这一步将丢弃修改。继续吗？')) return; setQuestionDraft(null); setSegmentDraft(null); setSourceMode(null); router.replace(`/surveys/${id}?step=${to}`); };
  return <div className="mx-auto max-w-6xl space-y-6"><SurveyBack /><PageHeader title={data.title} desc={data.objective} actions={<SurveyStatus status={data.status} />} /><SyntheticNote />
    <nav aria-label="调研步骤" className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-white p-2">{steps.map(([key, label], i) => <button key={key} disabled={busy || pending || (key !== 'questions' && !data.questions.length)} onClick={() => navigate(key!)} aria-current={step === key ? 'step' : undefined} className={`flex items-center justify-center gap-2 rounded-lg px-2 py-3 text-xs font-medium sm:text-sm ${step === key ? 'bg-brand-50 text-brand-800' : 'text-slate-500 hover:bg-slate-50'} disabled:cursor-default`}><span className="hidden h-6 w-6 items-center justify-center rounded-full border border-current sm:flex">{i + 1}</span>{label}</button>)}</nav>
    {error && <SurveyError error={error} />}{data.lastError && <div role="status" className="rounded-xl bg-warn-50 p-4 text-sm text-slate-700">{data.lastError}</div>}
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_260px]"><section className="min-w-0 space-y-5">
      {step === 'questions' && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">让每一道题都回答一个问题</h2><p className="mt-1 text-xs leading-6 text-slate-500">可调整题型、选项和顺序。保存后才会用于作答。</p></div>{data.editable && <button className="btn-soft" disabled={pending || questionDirty} onClick={() => { if (data.questions.length && !window.confirm('重新生成会替换当前题目及人群建议，继续吗？')) return; action.mutate({ path: `/surveys/${id}/generate`, json: {} }); }}>{pending ? '正在提交…' : data.questions.length ? '重新生成' : 'AI 生成问卷'}</button>}</div>
        {data.status === 'generating' ? <div role="status" className="card p-8 text-center"><div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-700" /><h3 className="font-medium">正在设计问卷与人群建议</h3><p className="mt-2 text-sm text-slate-500">可以离开此页，结果会自动保存。</p><button className="btn-ghost mt-5" disabled={pending} onClick={() => action.mutate({ path: `/surveys/${id}/cancel` })}>取消生成</button></div> : <><QuestionEditor value={questions} onChange={setQuestionDraft} disabled={locked || pending} />{data.editable && questions.length > 0 && <div className="flex items-center justify-end gap-3"><span className="text-xs text-slate-500">{questionDirty ? '有未保存的修改' : '已保存'}</span><button className="btn-primary" disabled={pending || !validateSurveyQuestions(questions).ok} onClick={() => saveQuestions.mutate(questions)}>{saveQuestions.isPending ? '保存中…' : '保存问卷，选择人群 →'}</button></div>}</>}
      </>}
      {step === 'audience' && <><div><h2 className="text-lg font-semibold">由你决定听谁的声音</h2><p className="mt-1 text-xs leading-6 text-slate-500">每组可调整年龄、城市、收入、职业和样本量。修改题目或人群后需要重新确认。</p></div><label className="card block p-4 text-sm font-medium">人物来源<select aria-label="人物来源" className="input mt-2" disabled={locked || pending} value={sourceMode ?? data.pool?.sourceMode ?? 'generated'} onChange={e => setSourceMode(e.target.value)}><option value="generated">按配额生成</option><option value="hybrid">优先 Persona Hub，缺口生成</option><option value="persona_hub">仅 Persona Hub（无匹配时提示）</option></select><span className="mt-2 block text-xs font-normal leading-6 text-slate-500">Persona Hub 使用有来源记录的合成人物档案，缺失属性按配额赋值，保留来源追溯。非商业数据许可，匹配不足时会提示或明确使用生成样本。</span></label><SegmentEditor value={segments} onChange={setSegmentDraft} disabled={locked || pending} />
        {data.pool && !segmentDirty && <details className="card p-5"><summary className="cursor-pointer text-sm font-semibold">逐条查看人群名单（{data.pool.size} 位人物）<span className="ml-2 text-xs font-normal text-slate-400">确认前先点名审阅</span></summary><div className="mt-4"><PersonaBrowser surveyId={id} poolId={data.pool.id} segments={data.pool.spec.segments} /></div></details>}
        {data.editable && <div className="space-y-4">{(!data.pool || segmentDirty) ? <button className="btn-primary" disabled={pending || !validateSurveySegments(segments).ok} onClick={() => savePool.mutate(segments)}>{savePool.isPending ? '正在保存…' : '保存人群方案'}</button> : <div className="rounded-xl border border-brand-200 bg-brand-50 p-5"><p className="text-sm font-medium">{data.pool.approved ? '人群方案已确认' : '人群方案已保存，等待你的确认'}</p><p className="mt-1 text-xs leading-6 text-slate-600">{data.pool.size} 位合成人物将独立回答已保存的 {data.questions.length} 道题。</p>{!data.pool.approved ? <button className="btn-primary mt-3" disabled={pending} onClick={() => action.mutate({ path: `/surveys/${id}/pools/${data.pool!.id}/approve`, json: { approved: true } })}>确认使用此人群</button> : <button className="btn-primary mt-3" onClick={() => navigate('run')}>查看运行计划 →</button>}</div>}</div>}
      </>}
      {step === 'run' && <><div className="card p-6 sm:p-8"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">{busy ? '正在收集不同视角' : data.status === 'completed' ? '调研已完成' : '准备好，开始听取回答'}</h2><SurveyStatus status={data.status} /></div><dl className="grid grid-cols-3 gap-3"><div><dt className="text-xs text-slate-500">计划样本</dt><dd className="mt-2 text-3xl font-semibold tabular-nums">{total}</dd></div><div><dt className="text-xs text-slate-500">有效回答</dt><dd className="mt-2 text-3xl font-semibold tabular-nums text-brand-700">{completed}</dd></div><div><dt className="text-xs text-slate-500">待补跑</dt><dd className="mt-2 text-3xl font-semibold tabular-nums text-slate-500">{Math.max(0, total - completed)}</dd></div></dl><div className="mt-6 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="样本处理进度" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-brand-600 transition-[width]" style={{ width: `${percent}%` }} /></div><p aria-live="polite" className="mt-2 text-xs text-slate-500">已处理 {completed + failed} / {total} 份{failed > 0 ? `，其中 ${failed} 份未通过验证` : ''}</p>
        {!busy && data.status !== 'completed' && <div className="mt-6 rounded-xl bg-slate-50 p-4 text-sm leading-7 text-slate-600"><p>本次将进行约 {Math.max(0, total - completed)} 次独立 AI 作答调用，会消耗当前配置模型的额度，失败重试可能增加调用次数。</p><p>参考耗时：{Math.max(1, Math.ceil((total - completed) * 5 / 3 / 60))}–{Math.max(1, Math.ceil((total - completed) * 30 / 3 / 60))} 分钟，取决于模型响应及重试。结果会持续保存，可随时离开。</p></div>}
        <div className="mt-6 flex flex-wrap gap-3">{busy ? <button className="btn-ghost" disabled={pending} onClick={() => action.mutate({ path: `/surveys/${id}/cancel` })}>停止作答，保留结果</button> : data.status !== 'completed' && <button className="btn-primary" disabled={!runReady || pending} onClick={() => action.mutate({ path: `/surveys/${id}/run`, json: {} })}>{pending ? '正在提交…' : completed || failed || data.status === 'cancelled' ? '补跑缺失样本' : '确认开始作答'}</button>}{completed > 0 && <Link className={busy ? 'btn-ghost' : 'btn-primary'} href={`/surveys/reports?surveyId=${id}`}>{data.status === 'completed' ? '查看完整报告 →' : '查看已有结果 →'}</Link>}</div>{!data.pool?.approved && <p className="mt-3 text-sm text-warn-600">请先在「选择人群」中保存并确认方案。</p>}</div></>}
    </section><aside className="card space-y-5 p-5"><h2 className="text-sm font-semibold">调研概览</h2><dl className="space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">已保存题目</dt><dd>{data.questions.length} 题</dd></div><div className="flex justify-between"><dt className="text-slate-500">人群方案</dt><dd>{data.pool ? `${data.pool.spec.segments.length} 组` : '待选择'}</dd></div><div className="flex justify-between"><dt className="text-slate-500">计划样本</dt><dd>{data.pool?.size ?? '—'}</dd></div><div className="flex justify-between"><dt className="text-slate-500">确认状态</dt><dd>{data.pool?.approved ? '已确认' : '待确认'}</dd></div></dl><div className="border-t border-slate-100 pt-4 text-xs leading-6 text-slate-500">建议保持题目中立、一次只问一件事，并为选择题补充「其他」或「不确定」选项。</div><p className="text-xs text-slate-400">最近保存：{new Date(data.updatedAt).toLocaleString('zh-CN')}</p></aside></div>
  </div>;
}
