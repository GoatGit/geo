'use client';
import { engineLabel } from '@geo/shared';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Badge, PageHeader, Skeleton } from '@/components/ui';
import { WEB_ENGINES } from '@geo/shared';

interface AccountRow {
  id: number;
  engine: string;
  surface: string;
  status: string;
  healthScore: number;
  dailyUsed: number;
  cooldownUntil: string | null;
  retiredAt: string | null;
  createdAt: string;
  loginSessionId?: string | null;
}

interface LoginState {
  state: 'queued' | 'running' | 'done' | 'timeout' | 'error' | 'cancelled';
  detail?: string;
  viewer?: boolean;
  updatedAt: string;
}

const STATUS_META: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'slate' }> = {
  available: { label: '可用', tone: 'good' },
  pending_login: { label: '待登录', tone: 'warn' },
  login_required: { label: '需重登', tone: 'bad' },
  cooldown: { label: '冷却中', tone: 'slate' },
  retired: { label: '已退役', tone: 'slate' },
};


/**
 * 远程登录实时画面(viewer):worker 把远程/无头浏览器页面截帧写 Redis,
 * 这里轮询展示;点击画面转发为远程鼠标点击,文字/回车按钮转发键盘输入——
 * 生产 agentbay 云端浏览器与本地无头模式统一走此通道完成人工扫码/验证码登录。
 */
function ViewerPanel({ sessionId, label }: { sessionId: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const commandQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<{ frame: string | null }>(`/admin/login/${sessionId}/frame`);
        if (!stopped && r.frame) setSrc(`data:image/jpeg;base64,${r.frame}`);
      } catch {
        // 单帧失败忽略,下一轮重取
      }
      if (!stopped) timer = setTimeout(poll, 1_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId]);

  const send = (cmd: Record<string, unknown>) => {
    const next = commandQueue.current.then(() => api(`/admin/login/${sessionId}/input`, { method: 'POST', json: cmd }));
    commandQueue.current = next.catch(() => undefined);
    return next.then(() => { setHint(''); return true; }, (e) => { setHint((e as Error).message); return false; });
  };
  const sendText = async () => {
    if (!text || sending) return;
    setSending(true);
    if (await send({ type: 'type', text })) setText('');
    setSending(false);
  };

  const coordinates = (e: React.PointerEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(img.naturalWidth - 1, Math.round(((e.clientX - rect.left) * img.naturalWidth) / rect.width)));
    const y = Math.max(0, Math.min(img.naturalHeight - 1, Math.round(((e.clientY - rect.top) * img.naturalHeight) / rect.height)));
    return { x, y };
  };

  return (
    <section className="card rise-2 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">{label} · 远程登录</h3>
      <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {src ? (
          <img
            ref={imgRef}
            src={src}
            alt="远程浏览器实时画面"
            className="w-full cursor-crosshair select-none touch-none"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              pointerStart.current = coordinates(e);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerUp={(e) => {
              const start = pointerStart.current;
              const end = coordinates(e);
              pointerStart.current = null;
              if (!start || !end) return;
              void send(Math.hypot(end.x - start.x, end.y - start.y) < 4
                ? { type: 'click', ...start }
                : { type: 'drag', ...start, toX: end.x, toY: end.y });
            }}
            onPointerCancel={() => { pointerStart.current = null; }}
            draggable={false}
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-xs text-slate-400">等待第一帧…</div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="input h-9 flex-1 min-w-48"
          placeholder="输入文字(手机号/验证码等),发送到画面中已聚焦的输入框"
          value={text}
          type="password"
          autoComplete="off"
          maxLength={200}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendText();
          }}
        />
        <button
          className="btn-primary h-9 px-4"
          disabled={sending || !text}
          onClick={() => void sendText()}
        >
          发送文字
        </button>
        <button className="h-9 px-3 text-sm text-slate-600" onClick={() => void send({ type: 'key', key: 'ControlOrMeta+A' })}>全选</button>
        <button className="h-9 px-3 text-sm text-slate-600" onClick={() => void send({ type: 'key', key: 'Tab' })}>下一输入框</button>
        <button className="h-9 px-3 text-sm text-slate-600" onClick={() => void send({ type: 'scroll', deltaY: -400 })}>向上滚动</button>
        <button className="h-9 px-3 text-sm text-slate-600" onClick={() => void send({ type: 'scroll', deltaY: 400 })}>向下滚动</button>
        <button className="h-9 px-4 text-sm text-slate-600 hover:text-slate-900" onClick={() => void send({ type: 'key', key: 'Enter' })}>
          回车
        </button>
        <button className="h-9 px-4 text-sm text-slate-600 hover:text-slate-900" onClick={() => void send({ type: 'key', key: 'Backspace' })}>
          退格
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        操作方式:点击画面任意位置 = 远程鼠标点击;先用「点击」聚焦输入框,再「发送文字」;
        拖动画面可操作滑块;手机扫码请对准画面中的二维码。画面约 1 秒一帧。
        {hint && <span className="ml-2 text-bad">{hint}</span>}
      </p>
    </section>
  );
}

/**
 * 平台后台 · 账号池人工登录(docs/04 §3.1 账号供给):
 * 登录需要真人扫码/验证码 → 后台登记账号档案后点「人工登录」,
 * worker 打开浏览器(本地弹窗或远程 viewer 画面),操作者完成登录,登录态持久化进账号档案。
 */
export default function AdminAccountsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-accounts'],
    queryFn: () => api<{ accounts: AccountRow[] }>('/admin/accounts'),
    refetchInterval: 15_000,
  });

  const [newEngine, setNewEngine] = useState<string>('doubao');
  const [newCount, setNewCount] = useState<number>(1);
  const [message, setMessage] = useState('');
  const [loginStates, setLoginStates] = useState<Record<number, LoginState & { sessionId: string }>>({});
  const pollingRef = useRef<Map<number, NodeJS.Timeout>>(new Map());
  const requestingRef = useRef(new Set<number>());

  useEffect(
    () => () => {
      for (const t of pollingRef.current.values()) clearInterval(t);
      pollingRef.current.clear();
    },
    [],
  );

  const accounts = data?.accounts ?? [];

  const startPolling = useCallback((profileId: number, sessionId: string) => {
    const prevTimer = pollingRef.current.get(profileId);
    if (prevTimer) clearInterval(prevTimer);
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const st = await api<LoginState>(`/admin/login/${sessionId}`);
        if (pollingRef.current.get(profileId) !== timer) return;
        setLoginStates((prev) => ({ ...prev, [profileId]: { ...st, sessionId } }));
        if (st.state === 'done' || st.state === 'timeout' || st.state === 'error' || st.state === 'cancelled') {
          clearInterval(timer);
          pollingRef.current.delete(profileId);
          void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
          void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
        }
      } catch (error) {
        if (pollingRef.current.get(profileId) !== timer) return;
        if (!(error instanceof ApiError) || error.code >= 500) {
          setLoginStates((prev) => ({ ...prev, [profileId]: { ...prev[profileId], sessionId, detail: '连接暂时中断,正在重试…' } }));
          return;
        }
        clearInterval(timer);
        pollingRef.current.delete(profileId);
        setLoginStates((prev) => ({
          ...prev,
          [profileId]: {
            ...(prev[profileId] ?? { viewer: false }),
            sessionId,
            state: 'error' as const,
            detail: '登录会话状态查询失败',
            updatedAt: new Date().toISOString(),
          },
        }));
      } finally { inFlight = false; }
    }, 2_500);
    pollingRef.current.set(profileId, timer);
  }, [queryClient]);

  useEffect(() => {
    for (const account of data?.accounts ?? []) {
      if (account.loginSessionId && !pollingRef.current.has(account.id)) {
        const sessionId = account.loginSessionId;
        setLoginStates((prev) => ({ ...prev, [account.id]: { state: 'queued', sessionId, detail: '正在恢复登录会话…', updatedAt: new Date().toISOString() } }));
        startPolling(account.id, sessionId);
      }
    }
  }, [data, startPolling]);

  const cancelLogin = async (profileId: number, sessionId: string) => {
    try {
      await api(`/admin/login/${sessionId}/cancel`, { method: 'POST' });
      // 轮询会拉到 cancelled 终态并自行停止;立即置状态给操作者即时反馈
      setLoginStates((prev) => ({
        ...prev,
        [profileId]: { ...prev[profileId], sessionId, detail: '取消中…', updatedAt: new Date().toISOString() },
      }));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const requestLogin = async (id: number) => {
    if (requestingRef.current.has(id)) return;
    requestingRef.current.add(id);
    setMessage('');
    try {
      const r = await api<{ sessionId: string }>(`/admin/accounts/${id}/login`, { method: 'POST' });
      setLoginStates((prev) => ({
        ...prev,
        [id]: { state: 'queued', sessionId: r.sessionId, detail: '已提交,等待 worker 打开浏览器…', updatedAt: new Date().toISOString() },
      }));
      startPolling(id, r.sessionId);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      requestingRef.current.delete(id);
    }
  };

  const createAccount = async () => {
    setMessage('');
    try {
      const r = await api<{ created: number }>('/admin/accounts/batch', {
        method: 'POST',
        json: { engine: newEngine, count: newCount },
      });
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
      setMessage(`已添加 ${r.created} 个 ${engineLabel(newEngine)} 账号(待登录),逐个点「人工登录」完成扫码`);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const setStatus = async (id: number, action: 'disable' | 'enable') => {
    try {
      await api(`/admin/accounts/${id}/${action}`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  // 每引擎存量统计(供给水位一目了然)
  const engineSummary = WEB_ENGINES.map((e) => {
    const rows = accounts.filter((a) => a.engine === e);
    return {
      engine: e,
      total: rows.length,
      available: rows.filter((a) => a.status === 'available').length,
      pending: rows.filter((a) => a.status === 'pending_login' || a.status === 'login_required').length,
    };
  });

  const viewerEntries = Object.entries(loginStates).filter(
    ([, st]) => st.viewer && st.sessionId && (st.state === 'running' || st.state === 'queued'),
  );

  if (isLoading || !data) return <Skeleton />;

  return (
    <>
      <PageHeader
        title="账号池"
        desc="五引擎账号档案与人工登录:本地弹窗或远程实时画面(viewer)完成扫码/验证码,登录态持久化后由采集 worker 复用"
      />

      <section className="card rise p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {engineSummary.map((s) => (
            <span key={s.engine} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
              {engineLabel(s.engine)}:{s.available}/{s.total} 可用
              {s.pending > 0 && <span className="ml-1 text-warn">(待登录 {s.pending})</span>}
            </span>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">添加账号</h2>
          <select className="input h-9 w-40" value={newEngine} onChange={(e) => setNewEngine(e.target.value)}>
            {WEB_ENGINES.map((e) => (
              <option key={e} value={e}>
                {engineLabel(e)}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={20}
            className="input h-9 w-20"
            value={newCount}
            onChange={(e) => setNewCount(Math.min(Math.max(Math.floor(Number(e.target.value) || 1), 1), 20))}
          />
          <span className="text-xs text-slate-500">个</span>
          <button className="btn-primary h-9 px-5" onClick={() => void createAccount()}>
            添加账号
          </button>
          {message && <span className="text-xs text-slate-500">{message}</span>}
        </div>
        <p className="text-xs leading-5 text-slate-500">
          流程:添加账号(待登录)→ 点该行「人工登录」→ 本地模式弹出浏览器窗口 / agentbay 与
          LOGIN_VIEWER=1 模式在下方实时画面中操作(点击画面 = 远程鼠标,发送文字 = 远程键盘)→
          系统验证并保存登录态后自动入可用池。默认等待 10 分钟,以登录状态中的剩余时间为准,超时可重试。
        </p>
      </section>

      {viewerEntries.map(([profileId, st]) => (
        <ViewerPanel key={st.sessionId} sessionId={st.sessionId} label={`${engineLabel(accounts.find((a) => a.id === Number(profileId))?.engine ?? '')} #${profileId}`} />
      ))}

      <section className="card rise-1 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
              <th className="px-5 py-3 font-medium">引擎 / 档案</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">健康分</th>
              <th className="px-5 py-3 font-medium">今日用量</th>
              <th className="px-5 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-xs text-slate-400">
                  账号池为空:先登记档案,再人工登录注入账号态
                </td>
              </tr>
            )}
            {accounts.map((a) => {
              const meta = STATUS_META[a.status] ?? { label: a.status, tone: 'slate' as const };
              const st = loginStates[a.id];
              const busy = st?.state === 'queued' || st?.state === 'running';
              return (
                <tr key={a.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">{engineLabel(a.engine)}</div>
                    <div className="text-xs text-slate-400">profile #{a.id}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge label={meta.label} tone={meta.tone} />
                  </td>
                  <td className="px-5 py-3 tabular-nums">{a.healthScore}</td>
                  <td className="px-5 py-3 tabular-nums">{a.dailyUsed}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-primary h-8 px-3 text-xs disabled:opacity-50"
                        disabled={busy || a.status === 'retired'}
                        onClick={() => void requestLogin(a.id)}
                      >
                        {busy ? '登录中…' : '人工登录'}
                      </button>
                      {busy && st?.sessionId && (
                        <button className="h-8 px-3 text-xs text-bad hover:opacity-80" onClick={() => void cancelLogin(a.id, st.sessionId)}>
                          取消登录
                        </button>
                      )}
                      {a.status === 'retired' ? (
                        <button className="h-8 px-3 text-xs text-slate-500 hover:text-slate-800" onClick={() => void setStatus(a.id, 'enable')}>
                          启用
                        </button>
                      ) : (
                        <button className="h-8 px-3 text-xs text-slate-500 hover:text-slate-800" onClick={() => void setStatus(a.id, 'disable')}>
                          停用
                        </button>
                      )}
                    </div>
                    {st && (
                      <div
                        className={`mt-1 text-xs ${
                          st.state === 'done'
                            ? 'text-good'
                            : st.state === 'error' || st.state === 'timeout' || st.state === 'cancelled'
                              ? 'text-bad'
                              : 'text-slate-500'
                        }`}
                      >
                        {st.detail ?? st.state}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
