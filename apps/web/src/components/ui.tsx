'use client';

/** 页面通用组件:骨架屏(shimmer)/空态/徽章/页头。 */

export function Badge({ label, tone = 'slate' }: { label: string; tone?: 'slate' | 'brand' | 'good' | 'warn' | 'bad' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
    good: 'bg-good-50 text-good',
    warn: 'bg-warn-50 text-warn',
    bad: 'bg-bad-50 text-bad',
  } as const;
  return <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}>{label}</span>;
}

export function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-44 rounded-lg bg-slate-100" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 overflow-hidden rounded-xl border border-slate-100 bg-slate-50">
            <div className="h-full w-full animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,.8),transparent)] bg-[length:400px_100%]" />
          </div>
        ))}
      </div>
      <div className="h-64 overflow-hidden rounded-xl border border-slate-100 bg-slate-50">
        <div className="h-full w-full animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,.8),transparent)] bg-[length:400px_100%]" />
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  text,
  action,
}: {
  title?: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card rise flex flex-col items-center justify-center px-8 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </div>
      {title && <h3 className="mb-1 text-sm font-semibold text-slate-800">{title}</h3>}
      <p className="max-w-md text-sm leading-6 text-slate-500">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  desc,
  actions,
}: {
  title: React.ReactNode;
  /** 副标题按需慎用(整体设计上少用) */
  desc?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="rise flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">{title}</h1>
        {desc && <p className="mt-1 text-sm leading-5 text-slate-500">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
