'use client';

/** 页面通用小组件(骨架屏/空态/徽章)。 */
export function Badge({ label }: { label: string }) {
  return <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{label}</span>;
}

export function Skeleton() {
  return <div className="h-40 animate-pulse rounded-lg bg-slate-100" />;
}

export function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-slate-500">{text}</div>;
}

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
