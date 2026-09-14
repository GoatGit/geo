import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="metric-num text-7xl font-semibold text-brand-300">404</p>
      <h1 className="mt-4 text-xl font-semibold text-slate-900">这一页不在任何 AI 的推荐列表里</h1>
      <p className="mt-2 text-sm text-slate-500">你访问的页面不存在,或已被移除。</p>
      <Link
        href="/"
        className="btn-primary mt-8"
      >
        返回首页
      </Link>
    </div>
  );
}
