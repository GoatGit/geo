'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { IconChevron } from './icons';

/**
 * 横向 scroll-snap 轨道 + 翻页按钮(总览/官网行业洞察共用):
 * 每屏 N 张由调用方以卡片宽度类控制;超出部分手势滑动或按钮翻页。
 */
export function SnapRail({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={`-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

/** 翻页按钮:按轨道实际可滚动状态启停;放标题行或轨道下方均可。 */
export function SnapPager({ scrollerId, className }: { scrollerId: string; className?: string }) {
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  useEffect(() => {
    const el = document.getElementById(scrollerId);
    if (!el) return;
    const update = () => {
      setCanLeft(el.scrollLeft > 8);
      setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [scrollerId]);
  const page = (dir: 1 | -1) => {
    const el = document.getElementById(scrollerId);
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };
  return (
    <span className={`flex items-center gap-1 ${className ?? ''}`}>
      <button
        aria-label="上一页"
        className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition-colors hover:border-brand-300 hover:text-brand disabled:opacity-30 disabled:hover:border-slate-200 disabled:hover:text-slate-400"
        disabled={!canLeft}
        onClick={() => page(-1)}
      >
        <IconChevron width={13} height={13} className="-rotate-90" />
      </button>
      <button
        aria-label="下一页"
        className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition-colors hover:border-brand-300 hover:text-brand disabled:opacity-30 disabled:hover:border-slate-200 disabled:hover:text-slate-400"
        disabled={!canRight}
        onClick={() => page(1)}
      >
        <IconChevron width={13} height={13} className="rotate-90" />
      </button>
    </span>
  );
}
