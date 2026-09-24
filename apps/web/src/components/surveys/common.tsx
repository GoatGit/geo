'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { STATUS } from './types';
export function SurveyStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'slate' as const };
  return <Badge label={s.label} tone={s.tone} />;
}
export function SurveyError({ error, retry }: { error: Error; retry?: () => void }) {
  return <div role="alert" className="rounded-xl border border-bad-100 bg-bad-50 p-5 text-sm text-bad-600"><p>{error.message}</p>{retry && <button className="btn-ghost mt-3" onClick={retry}>重新加载</button>}</div>;
}
export function SurveyBack() { return <Link href="/surveys" className="inline-flex text-sm text-slate-500 hover:text-brand-700">← 全部调研</Link>; }
export function SyntheticNote() {
  return <p className="rounded-xl bg-sand-50 px-4 py-3 text-xs leading-6 text-slate-600">本功能使用 AI 合成样本，适合探索需求、发现顾虑与预筛选问卷。可用真人数据校准已知偏差，校准记录以报告为准；合成结果仍需真人调研验证。</p>;
}
