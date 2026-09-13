'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, brandStore, tokenStore } from '../lib/api';

interface BrandRow {
  id: number;
  name: string;
}

const NAV = [
  { href: '/dashboard', label: '总览' },
  { href: '/monitor/rankings', label: '排名透视' },
  { href: '/monitor/citations', label: '引用源' },
  { href: '/reputation', label: '口碑分析' },
  { href: '/config/questions', label: '监控问题' },
  { href: '/config/recognition', label: '识别口径' },
  { href: '/config/collection', label: '采集状态' },
  { href: '/reports', label: '报告中心' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/login';

  const brands = useQuery({
    queryKey: ['brands'],
    queryFn: () => api<BrandRow[]>('/brands'),
    enabled: !isLogin && !!tokenStore.access,
  });

  if (isLogin) return <div className="min-h-screen">{children}</div>;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col bg-slate-900 text-slate-200">
        <div className="px-5 py-5">
          <div className="text-lg font-semibold tracking-wide text-white">GeoLens</div>
          <div className="text-xs text-slate-400">AI 搜索品牌可见性监测</div>
        </div>
        <BrandSwitcher brands={brands} />
        <nav className="mt-4 flex-1 space-y-0.5 px-2">
          {NAV.map((n) => {
            const active = pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`block rounded px-3 py-2 text-sm ${active ? 'bg-brand text-white' : 'hover:bg-slate-800'}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <button
          className="m-4 rounded px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-800"
          onClick={() => {
            tokenStore.clear();
            router.replace('/login');
          }}
        >
          退出登录
        </button>
      </aside>
      <main className="flex-1 overflow-x-auto p-6">{children}</main>
    </div>
  );
}

function BrandSwitcher({ brands: query }: { brands: { data?: BrandRow[] } }) {
  const current = brandStore.get();
  const rows = query.data ?? [];
  return (
        <div className="px-4">
          <label className="mb-1 block text-xs text-slate-400">品牌工作区</label>
          <select
            className="w-full rounded bg-slate-800 px-2 py-1.5 text-sm text-white"
            value={current ?? rows[0]?.id ?? ''}
            onChange={(e) => {
              brandStore.set(Number(e.target.value));
              window.location.reload();
            }}
          >
            {rows.length === 0 && <option value="">暂无品牌</option>}
            {rows.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <Link href="/brands/new" className="mt-2 block text-xs text-brand-muted hover:underline">
            + 新建品牌
          </Link>
        </div>
  );
}
