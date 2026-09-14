import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 text-center">
      <p className="metric-num text-7xl font-semibold text-brand-300/40">404</p>
      <h1 className="mt-4 text-xl font-semibold text-white">这一页不在任何 AI 的推荐列表里</h1>
      <p className="mt-2 text-sm text-slate-400">你访问的页面不存在,或已被移除。</p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-brand-400 active:scale-[.98]"
      >
        返回首页
      </Link>
    </div>
  );
}
