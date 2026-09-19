'use client';

/**
 * GSAP 动效基建(gsap-react 技能规范):
 * - useGSAP 统一生命周期(scope + 自动 revert),不在 SSR 期执行任何 gsap 调用
 * - 全部尊重 prefers-reduced-motion:命中时直接呈现终态,不启动动画
 * - CountUp:数据到达时的数字滚动(功能性动效,响应数据而非装饰)
 * - Reveal:折叠下方内容进入视口时的错落入场(ScrollTrigger, once)
 */
import { useRef, useState, type ReactNode } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger);
  // ScrollTrigger 起点缓存会因晚到的字体/图片/数据布局变化而过期(锚点跳转时浏览器
  // 在水合前已滚动,触发器创建时读不到正确位置 → 内容卡在 from() 隐形初始态)。
  // load 后统一刷新 + 延迟再刷一次,覆盖晚到布局
  const w = window as Window & { __geoStRefreshed?: boolean };
  if (!w.__geoStRefreshed) {
    w.__geoStRefreshed = true;
    window.addEventListener('load', () => ScrollTrigger.refresh());
    window.setTimeout(() => ScrollTrigger.refresh(), 1_500);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 数字滚动:target 变化时 650ms power2-out 递增;null 不动画(显示占位由调用方处理)。 */
export function useCountUp(target: number | null, duration = 0.65): number | null {
  const [v, setV] = useState<number | null>(target == null ? null : 0);
  const state = useRef({ n: 0 });
  useGSAP(
    () => {
      if (target == null) return;
      if (prefersReducedMotion()) {
        setV(target);
        return;
      }
      state.current.n = 0;
      setV(0);
      gsap.to(state.current, {
        n: target,
        duration,
        ease: 'power2.out',
        onUpdate: () => setV(state.current.n),
      });
    },
    { dependencies: [target] },
  );
  return target == null ? null : v;
}

/** 数字滚动展示组件:null 显示 —,整数/小数由 decimals 控制。 */
export function CountUp({
  value,
  decimals = 0,
  className,
}: {
  value: number | null;
  decimals?: number;
  className?: string;
}) {
  const v = useCountUp(value);
  return <span className={className}>{value == null || v == null ? '—' : v.toFixed(decimals)}</span>;
}

/**
 * 进入视口时的错落入场:容器本身即布局元素(把 grid/flex 类名直接给它),
 * 动画作用于直接子元素;reduced-motion / SSR 降级为直接可见。
 */
export function Reveal({
  children,
  className,
  delay = 0,
  stagger = 0.08,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  stagger?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || prefersReducedMotion() || el.children.length === 0) return;
      const kids = Array.from(el.children);
      const tween = gsap.from(kids, {
        y: 22,
        opacity: 0,
        duration: 0.6,
        delay,
        stagger,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 92%', once: true },
      });
      // 内容可见性死线:任何原因(锚点跳转竞态/晚到布局)导致触发点未结算时,
      // 3s 后强制清除隐形初始态——内容绝不允许因动效永远消失
      const failsafe = window.setTimeout(() => {
        if (getComputedStyle(kids[0] as Element).opacity === '0') {
          tween.scrollTrigger?.kill();
          gsap.set(kids, { clearProps: 'all' });
        }
      }, 3_000);
      return () => window.clearTimeout(failsafe);
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
