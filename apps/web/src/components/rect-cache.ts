/**
 * 布局矩形缓存(canvas-ui 组件的指针事件高频读取 getBoundingClientRect 会强制布局,
 * 缓存到 scroll/resize 时刷新;契约与 canvas-ui 的 rect-cache 一致):
 * { current: DOMRect, destroy() }
 */
export interface RectCache {
  current: DOMRect;
  destroy(): void;
}

export function createRectCache(el: HTMLElement): RectCache {
  const cache = { current: el.getBoundingClientRect() } as RectCache;
  const refresh = () => {
    cache.current = el.getBoundingClientRect();
  };
  window.addEventListener("scroll", refresh, { passive: true, capture: true });
  window.addEventListener("resize", refresh, { passive: true });
  cache.destroy = () => {
    window.removeEventListener("scroll", refresh, { capture: true });
    window.removeEventListener("resize", refresh);
  };
  return cache;
}
