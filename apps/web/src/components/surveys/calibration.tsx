'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseHumanCsv, validateCalibrationInput, type CalibrationInput, type CalibrationResult, type CalibrationTarget, type SurveyQuestion } from '@geo/shared';
import { api } from '@/lib/api';
import { SurveyError } from './common';
export interface CalibrationRecord { id: number; benchmark: CalibrationInput; result: CalibrationResult; applied: boolean; responseCount: number; createdAt: string }
export function CalibrationPanel({ surveyId, questions, enabled }: { surveyId: number; questions: SurveyQuestion[]; enabled: boolean }) {
  const cache = useQueryClient();
  const eligible = questions.filter(q => q.type === 'single' || q.type === 'scale');
  const [title, setTitle] = useState(''), [source, setSource] = useState(''), [population, setPopulation] = useState(''), [sampleSize, setSampleSize] = useState(0), [collectedAt, setDate] = useState('');
  const [targets, setTargets] = useState<CalibrationTarget[]>([]), [fileError, setFileError] = useState<Error | null>(null);
  const csvRead = useRef(0);
  const [isParsing, setIsParsing] = useState(false);
  useEffect(() => () => { csvRead.current++; }, []);
  const [tab, setTab] = useState<'manual' | 'csv'>('manual');
  const input: CalibrationInput = { title, source, population, sampleSize, collectedAt, targets };
  const check = validateCalibrationInput(input, questions);
  const history = useQuery({ queryKey: ['calibrations', surveyId], queryFn: () => api<CalibrationRecord[]>(`/surveys/${surveyId}/calibrations`) });
  const calibrate = useMutation({ mutationFn: () => api<CalibrationRecord>(`/surveys/${surveyId}/calibrations`, { method: 'POST', json: input }), onSuccess: async () => {
    await cache.invalidateQueries({ queryKey: ['calibrations', surveyId] }); void cache.invalidateQueries({ queryKey: ['survey-report', surveyId] }); void cache.invalidateQueries({ queryKey: ['survey-pools'] });
  } });
  const importCsv = async (file?: File) => {
    const request = ++csvRead.current;
    setFileError(null); setTargets([]); setSampleSize(0); setIsParsing(Boolean(file));
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error('CSV 最大 5 MB');
      const parsed = parseHumanCsv(await file.text(), questions);
      if (request !== csvRead.current) return;
      setSampleSize(parsed.sampleSize); setTargets(parsed.targets);
    } catch (error) {
      if (request === csvRead.current) setFileError(error instanceof Error ? error : new Error('CSV 解析失败'));
    } finally {
      if (request === csvRead.current) setIsParsing(false);
    }
  };
  const switchTab = (next: 'manual' | 'csv') => {
    csvRead.current++; setIsParsing(false); setFileError(null); setTab(next);
  };
  const untouched = !title && !source && !population && !collectedAt && !sampleSize && !targets.length;
  const toggle = (q: SurveyQuestion, checked: boolean) => { setTargets(previous => checked ? [...previous, { questionId: q.id, shares: Object.fromEntries((q.type === 'scale' ? Array.from({ length: 10 }, (_, i) => String(i + 1)) : q.options ?? []).map(v => [v, 0])) }] : previous.filter(t => t.questionId !== q.id)); };
  return <section className="card p-5 sm:p-7"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">真人数据校准</h2><p className="mt-2 text-sm leading-7 text-slate-500">用相同题目、相同选项的真人调查分布校准本次合成样本。权重通过后应用到报告，原始回答保持不变。</p></div></div>
    <p className="mt-3 rounded-lg bg-sand-50 p-3 text-xs leading-6 text-slate-600">校准用于减少已知题目的偏差，不等于独立验证，也不保证其他问题准确。请使用与本调研目标人群一致的真人数据；不要把模型生成的数据当真人基准。</p>
    {!enabled && <p className="mt-4 text-sm text-warn-600">请等待作答结束，至少有 5 份有效回答后再校准。</p>}
    <fieldset disabled={!enabled || calibrate.isPending} className="mt-5 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-slate-500">基准名称<input aria-label="基准名称" className="input mt-2" maxLength={120} placeholder="例如：2026 年客户满意度调查" value={title} onChange={e => setTitle(e.target.value)} /></label><label className="text-xs text-slate-500">来源链接或文档编号<input aria-label="真人数据来源" className="input mt-2" maxLength={500} value={source} onChange={e => setSource(e.target.value)} placeholder="用于追溯的公开链接或内部编号" /></label><label className="text-xs text-slate-500">真人调查对象<input aria-label="真人调查对象" className="input mt-2" maxLength={300} value={population} onChange={e => setPopulation(e.target.value)} placeholder="地区、年龄及筛选条件" /></label><label className="text-xs text-slate-500">调查/发布日<input aria-label="真人调查日期" className="input mt-2" type="date" value={collectedAt} onChange={e => setDate(e.target.value)} /></label><label className="text-xs text-slate-500">真人有效样本量<input aria-label="真人有效样本量" className="input mt-2" type="number" min={1} max={100000000} value={sampleSize || ''} onChange={e => setSampleSize(Number(e.target.value))} /></label></div>
      <div className="flex gap-2"><button type="button" className={tab === 'manual' ? 'btn-soft' : 'btn-ghost'} onClick={() => switchTab('manual')}>填写汇总占比</button><button type="button" className={tab === 'csv' ? 'btn-soft' : 'btn-ghost'} onClick={() => switchTab('csv')}>导入真人回答 CSV</button></div>
      {tab === 'csv' && <div className="rounded-xl border border-dashed border-slate-300 p-4"><label className="text-sm font-medium">选择 CSV 文件<input aria-label="真人回答 CSV" type="file" accept=".csv,text/csv" className="mt-3 block w-full text-xs" onChange={e => void importCsv(e.target.files?.[0])} /></label><p className="mt-3 text-xs leading-6 text-slate-500">UTF-8 编码，每行一位受访者。表头使用题目 ID（{eligible.map(q => q.id).join('、')}），值填写选项原文或 1–10 分。其他列会被忽略，原始个人资料不会上传，只提交汇总占比。每个选定问题必须有完整有效回答。</p></div>}
      <div className="space-y-3">{eligible.map(q => { const target = targets.find(t => t.questionId === q.id); return <div key={q.id} className="rounded-xl border border-slate-200 p-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={!!target} onChange={e => toggle(q, e.target.checked)} /><span><span className="mr-2 text-xs text-slate-400">{q.id}</span>{q.text}</span></label>{target && <div className="mt-4 grid gap-3 sm:grid-cols-2">{Object.entries(target.shares).map(([value, share]) => <label key={value} className="flex items-center justify-between gap-3 text-xs text-slate-600"><span className="min-w-0 break-words">{value}</span><span className="flex shrink-0 items-center gap-1"><input aria-label={`${q.id} ${value} 真人占比`} type="number" min={0} max={100} step="any" className="input !w-24" value={Number((share * 100).toFixed(4))} onChange={e => setTargets(targets.map(t => t.questionId === q.id ? { ...t, shares: { ...t.shares, [value]: Number(e.target.value) / 100 } } : t))} />%</span></label>)}<p className="text-xs text-slate-400 sm:col-span-2">合计 {(Object.values(target.shares).reduce((a,b) => a+b,0) * 100).toFixed(2)}%</p></div>}</div>; })}</div>
      {fileError && <SurveyError error={fileError} />}{calibrate.error && <SurveyError error={calibrate.error} />}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-500">{isParsing ? '正在读取 CSV…' : untouched ? '填写基准信息，再选择需要校准的题目或导入 CSV。' : !check.ok ? check.errors[0] : '元数据和占比校验通过，可以计算权重'}</p><button className="btn-primary" disabled={!check.ok || !enabled || calibrate.isPending || isParsing || !!fileError} onClick={() => calibrate.mutate()}>{calibrate.isPending ? '正在校准…' : '计算并应用校准'}</button></div>
    </fieldset>
    {history.error && <div className="mt-5"><SurveyError error={history.error} retry={() => void history.refetch()} /></div>}
    {!!history.data?.length && <div className="mt-6 space-y-4 border-t border-slate-100 pt-5"><h3 className="text-sm font-semibold">校准记录</h3>{history.data.map(record => <CalibrationSummary key={record.id} record={record} />)}</div>}
  </section>;
}
export function CalibrationSummary({ record }: { record: CalibrationRecord }) {
  const result = record.result;
  return <details className="rounded-xl border border-slate-200 p-4" open={record.applied}><summary className="cursor-pointer text-sm font-medium">{record.benchmark.title} · {record.applied ? '已应用' : result.status === 'passed' ? '历史校准' : '未达标，未应用'}</summary><div className="mt-3 space-y-2 text-xs leading-6 text-slate-600"><p>真人 N={record.benchmark.sampleSize} · 合成 N={record.responseCount} · 加权有效样本量 ESS={result.effectiveSampleSize.toFixed(1)}</p><p>调查对象：{record.benchmark.population} · {record.benchmark.collectedAt}</p><p className="break-words">来源：{record.benchmark.source}</p><p>方法：迭代比例加权，权重 0.05–20；最大偏差 ≤2 个百分点且 ESS ≥20%（至少 5）时通过。</p>{result.warnings.map(w => <p key={w} className="text-warn-600">{w}</p>)}<div className="overflow-x-auto"><table className="w-full text-left"><thead><tr className="text-slate-400"><th className="py-2">题目 / 选项</th><th>真人</th><th>校准前</th><th>校准后</th></tr></thead><tbody>{result.after.flatMap((q, i) => q.options.map((o, j) => <tr key={`${q.questionId}-${o.value}`} className="border-t border-slate-100"><td className="py-2 pr-3">{q.questionId} / {o.value}</td><td>{(o.target * 100).toFixed(1)}%</td><td>{((result.before[i]?.options[j]?.actual ?? 0) * 100).toFixed(1)}%</td><td>{(o.actual * 100).toFixed(1)}%</td></tr>))}</tbody></table></div></div></details>;
}
