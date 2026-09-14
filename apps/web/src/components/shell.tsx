'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, brandStore, isAdmin, tokenStore } from '../lib/api';
import {
  IconChevron,
  IconConfig,
  IconCite,
  IconDashboard,
  IconList,
  IconLogo,
  IconLogout,
  IconPanel,
  IconPlus,
  IconPulse,
  IconRank,
  IconReport,
  IconServer,
  IconShield,
  IconSwap,
  IconVoice,
  IconSwords,
  IconWallet,
} from './icons';

interface BrandRow {
  id: number;
  name: string;
}

type NavItem = { href: string; label: string; icon: React.ReactNode; exact?: boolean };
type NavGroup =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; label: string; icon: React.ReactNode; items: NavItem[] };

/** 导航重组(docs/01 IA):一级只留主干,细碎功能收进「配置」分组。 */
const NAV: NavGroup[] = [
  { kind: 'item', item: { href: '/dashboard', label: '总览', icon: <IconDashboard /> } },
  {
    kind: 'group',
    label: '监测',
    icon: <IconRank />,
    items: [
      { href: '/monitor/rankings', label: '排名透视', icon: <IconRank /> },
      { href: '/monitor/competitors', label: '竞品透视', icon: <IconSwords /> },
      { href: '/monitor/citations', label: '引用源分析', icon: <IconCite /> },
    ],
  },
  { kind: 'item', item: { href: '/reputation', label: '口碑分析', icon: <IconVoice /> } },
  { kind: 'item', item: { href: '/reports', label: '报告中心', icon: <IconReport /> } },
  { kind: 'item', item: { href: '/billing', label: '套餐与账单', icon: <IconWallet /> } },
  {
    kind: 'group',
    label: '配置',
    icon: <IconConfig />,
    items: [
      { href: '/config/questions', label: '监控问题', icon: <IconList /> },
      { href: '/config/recognition', label: '识别口径', icon: <IconShield /> },
      { href: '/config/collection', label: '采集状态', icon: <IconPulse /> },
    ],
  },
];

/** 平台后台分组(仅 admin 角色可见,接口层另有 AdminGuard 兜底)。 */
const ADMIN_NAV: NavGroup = {
  kind: 'group',
  label: '平台后台',
  icon: <IconServer />,
  items: [
    { href: '/admin', label: '系统总览', icon: <IconPulse />, exact: true },
    { href: '/admin/settings', label: '全局配置', icon: <IconConfig /> },
    { href: '/admin/rounds', label: '采集轮次', icon: <IconList /> },
  ],
};

/** 公开路由:官网首页与登录页不套控制台壳(未登录访问首页不再跳登录)。 */
const PUBLIC_ROUTES = ['/', '/login'];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_ROUTES.includes(pathname)) {
    return <div className="min-h-screen">{children}</div>;
  }
  return <ConsoleShell pathname={pathname}>{children}</ConsoleShell>;
}

function ConsoleShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!tokenStore.access) router.replace('/login');
    else setReady(true);
  }, [router]);
  if (!ready) return null;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar pathname={pathname} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main key={pathname} className="animate-fade-in mx-auto w-full max-w-6xl flex-1 px-8 py-7">
          {children}
        </main>
      </div>
    </div>
  );
}

/* ============ 侧栏 ============ */

const SIDEBAR_COLLAPSED_KEY = 'geo.sidebarCollapsed';

function Sidebar({ pathname }: { pathname: string }) {
  const nav = isAdmin() ? [...NAV, ADMIN_NAV] : NAV;
  // 折叠状态持久化;折叠时悬停自动浮层展开
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const [hovered, setHovered] = useState(false);
  const rail = collapsed && !hovered;

  const toggle = () =>
    setCollapsed((v) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '0' : '1');
      return !v;
    });

  return (
    <div className={`${rail ? 'w-[68px]' : 'w-[232px]'} shrink-0 transition-[width] duration-200`}>
      <aside
        onMouseEnter={() => collapsed && setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`sticky top-0 flex h-screen flex-col bg-ink-950 text-slate-300 transition-[width,box-shadow] duration-200 ${
          rail ? 'w-[68px]' : 'w-[232px]'
        } ${collapsed && hovered ? 'relative z-30 shadow-2xl' : ''}`}
      >
        <div className={`flex items-center gap-2.5 pb-2 pt-6 ${rail ? 'flex-col px-2' : 'px-5'}`}>
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-glow">
              <IconLogo width={18} height={18} />
            </span>
            {!rail && (
              <span>
                <span className="block text-[15px] font-semibold leading-4 tracking-wide text-white">GeoLens</span>
                <span className="block text-[10px] leading-4 text-slate-500">AI 搜索品牌可见性监测</span>
              </span>
            )}
          </Link>
          {!rail && (
            <button
              onClick={toggle}
              title="收起侧栏"
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-brand-300"
            >
              <IconPanel width={15} height={15} />
            </button>
          )}
        </div>

        {rail && (
          <button
            onClick={toggle}
            title="展开侧栏"
            className="mb-1 flex h-8 w-8 items-center justify-center self-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-brand-300"
          >
            <IconPanel width={15} height={15} />
          </button>
        )}

        <nav className={`mt-4 flex-1 space-y-0.5 overflow-y-auto overflow-x-visible pb-4 ${rail ? 'px-2' : 'px-3'}`}>
          {nav.map((g) =>
            g.kind === 'item' ? (
              <NavLink key={g.item.href} item={g.item} pathname={pathname} rail={rail} />
            ) : (
              <NavCollapsible key={g.label} group={g} pathname={pathname} rail={rail} />
            ),
          )}
        </nav>

        <div className={`border-t border-white/5 p-3 ${rail ? 'flex justify-center' : ''}`}>
          <Link
            href="/"
            title="返回官网"
            className={`flex items-center rounded-lg text-[13px] text-slate-400 transition-colors hover:bg-white/5 hover:text-brand-300 ${
              rail ? 'h-9 w-9 justify-center' : 'gap-2 px-3 py-2'
            }`}
          >
            <IconSwap width={15} height={15} />
            {!rail && '返回官网'}
          </Link>
        </div>
      </aside>
    </div>
  );
}

function NavLink({ item, pathname, rail }: { item: NavItem; pathname: string; rail: boolean }) {
  const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      title={rail ? item.label : undefined}
      className={`group relative flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 ${
        rail ? 'h-9 justify-center' : 'px-3 py-2'
      } ${
        active
          ? 'bg-gradient-to-r from-brand-600/90 to-brand-500/70 text-white shadow-sm'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
      }`}
    >
      <span className={active ? 'text-brand-200' : 'text-slate-500 transition-colors group-hover:text-brand-300'}>
        {item.icon}
      </span>
      {!rail && item.label}
    </Link>
  );
}

function NavCollapsible({
  group,
  pathname,
  rail,
}: {
  group: Extract<NavGroup, { kind: 'group' }>;
  pathname: string;
  rail: boolean;
}) {
  const match = (i: NavItem) => (i.exact ? pathname === i.href : pathname.startsWith(i.href));
  const expandedByDefault = group.items.some(match);
  const [open, setOpen] = useState(expandedByDefault);
  const active = group.items.some(match);

  if (rail) {
    return (
      <div className="flex justify-center">
        <button
          title={group.label}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
            active ? 'text-brand-300' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
          }`}
        >
          <span className={active ? 'text-brand-300' : 'text-slate-500'}>{group.icon}</span>
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
          active ? 'text-brand-300' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
        }`}
      >
        <span className={active ? 'text-brand-300' : 'text-slate-500 transition-colors group-hover:text-brand-300'}>
          {group.icon}
        </span>
        <span className="flex-1 text-left">{group.label}</span>
        <IconChevron
          width={14}
          height={14}
          className={`text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="min-h-0">
          <div className="ml-5 space-y-0.5 border-l border-white/10 py-1 pl-2">
            {group.items.map((item) => {
              const itemActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                    itemActive ? 'text-brand-300' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {itemActive && (
                    <span className="absolute -left-px top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand-400" />
                  )}
                  <span className="text-slate-500">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ 顶栏:品牌切换器 + 账户 ============ */

function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-slate-50/80 px-8 py-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
        <BrandSwitcher />
        <AccountMenu />
      </div>
    </header>
  );
}

function BrandSwitcher() {
  const query = useQuery({
    queryKey: ['brands'],
    queryFn: () => api<BrandRow[]>('/brands'),
  });
  const brands = query.data ?? [];
  const current = brandStore.get();
  const brand = brands.find((b) => b.id === current) ?? brands[0];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 健壮性:切换账号/数据重灌后 localStorage 里可能残留失效的 brandId → 自动落到首个可用品牌。
  // 必须整页刷新:各页面经 useBrandId() 非响应式读取,router.refresh() 不会让已挂载的客户端查询换 key 重取。
  const corrected = useRef(false);
  useEffect(() => {
    if (query.isLoading || corrected.current) return;
    if (brands.length > 0 && current !== brand?.id) {
      corrected.current = true;
      if (brand) {
        brandStore.set(brand.id);
        window.location.reload();
      }
    }
  }, [brands, brand, current, query.isLoading]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (id: number) => {
    brandStore.set(id);
    setOpen(false);
    window.location.reload();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-all hover:border-brand-300 hover:shadow-card-hover"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded bg-gradient-to-br from-brand-400 to-brand-600 text-[10px] font-bold text-white">
          {(brand?.name ?? '?').slice(0, 1)}
        </span>
        {brand?.name ?? '选择品牌'}
        {brands.length > 0 && (
          <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">{brands.length}</span>
        )}
        <IconChevron
          width={13}
          height={13}
          className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="card rise absolute left-0 top-full z-20 mt-2 w-60 p-1.5">
          {brands.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">还没有品牌</p>}
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => pick(b.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-brand-50 ${
                brand?.id === b.id ? 'text-brand-700' : 'text-slate-700'
              }`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-400 to-brand-600 text-[10px] font-bold text-white">
                {b.name.slice(0, 1)}
              </span>
              <span className="flex-1 truncate">{b.name}</span>
              {brand?.id === b.id && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />}
            </button>
          ))}
          <div className="my-1 border-t border-slate-100" />
          <Link
            href="/brands/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-brand-50 hover:text-brand-700"
          >
            <IconPlus width={14} height={14} />
            新建品牌
          </Link>
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-ink-700 to-ink-900 text-xs font-semibold text-white shadow-sm transition-transform hover:scale-105"
      >
        我
      </button>
      {open && (
        <div className="card rise absolute right-0 top-full z-20 mt-2 w-44 p-1.5">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-brand-50 hover:text-brand-700"
          >
            <IconSwap width={14} height={14} />
            返回官网
          </Link>
          <button
            onClick={() => {
              tokenStore.clear();
              router.replace('/login');
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-bad-50 hover:text-bad"
          >
            <IconLogout width={14} height={14} />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
