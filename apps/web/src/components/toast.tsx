'use client';

import { createContext, useCallback, useContext, useState } from 'react';

type Tone = 'ok' | 'err';
interface ToastItem {
  id: number;
  msg: string;
  tone: Tone;
}

const ToastCtx = createContext<(msg: string, tone?: Tone) => void>(() => {});

/** 轻量 toast(零依赖):成功/失败反馈,3.2s 自动退场。 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((msg: string, tone: Tone = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((v) => [...v.slice(-3), { id, msg, tone }]);
    setTimeout(() => setItems((v) => v.filter((i) => i.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 space-y-2">
        {items.map((i) => (
          <div
            key={i.id}
            className={`animate-fade-up flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-card-hover backdrop-blur ${
              i.tone === 'ok'
                ? 'border-good-100 bg-white/95 text-slate-700'
                : 'border-bad-100 bg-white/95 text-slate-700'
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                i.tone === 'ok' ? 'bg-good' : 'bg-bad'
              }`}
            >
              {i.tone === 'ok' ? '✓' : '!'}
            </span>
            {i.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
