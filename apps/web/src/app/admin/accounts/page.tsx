'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
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
  hasLoginState: boolean;
  createdAt: string;
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

const ENGINE_LABELS: Record<string, string> = {
  doubao: '豆包',
  deepseek: 'DeepSeek',
  wenxin: '百度文心助手',
  qwen: '通义千问',
  yuanbao: '腾讯元宝',
};

/**
 * 远程登录实时画面(viewer):worker 把远程/无头浏览器页面截帧写 Redis,
 * 这里轮询展示;点击画面转发为远程鼠标点击,文字/回车按钮转发键盘输入——
 * 生产 agentbay 云端浏览器与本地无头模式统一走此通道完成人工扫码/验证码登录。
 */
function ViewerPanel({ sessionId }: { sessionId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await api<{ frame: string | null }>(`/admin/login/${sessionId}/frame`);
        if (r.frame) setSrc(`data:image/jpeg;base64,${r.frame}`);
      } catch {
        // 单帧失败忽略,下一轮重取
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [sessionId]);

  const send = (cmd: Record<string, unknown>) =>
    api(`/admin/login/${sessionId}/input`, { method: 'POST', json: cmd }).catch((e) => setHint((e as Error).message));

  const onClickImage = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) * img.naturalWidth) / rect.width);
    const y = Math.round(((e.clientY - rect.top) * img.naturalHeight) / rect.height);
    void send({ type: 'click', x, y });
  };

  return (
    <section className="card rise-2 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">远程登录实时画面</h3>
      <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {src ? (
          <img
            ref={imgRef}
            src={src}
            alt="远程浏览器实时画面"
            className="w-full cursor-crosshair select-none"
            onClick={onClickImage}
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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text) {
              void send({ type: 'type', text });
              setText('');
            }
          }}
        />
        <button
          className="btn-primary h-9 px-4"
          onClick={() => {
            if (text) void send({ type: 'type', text });
            setText('');
          }}
        >
          发送文字
        </button>
        <button className="h-9 px-4 text-sm text-slate-600 hover:text-slate-900" onClick={() => void send({ type: 'key', key: 'Enter' })}>
          回车
        </button>
        <button className="h-9 px-4 text-sm text-slate-600 hover:text-slate-900" onClick={() => void send({ type: 'key', key: 'Backspace' })}>
          退格
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        操作方式:点击画面任意位置 = 远程鼠标点击;先用「点击」聚焦输入框,再「发送文字」;
        手机扫码请对准画面中的二维码。画面约 1 秒一帧。
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

  useEffect(
    () => () => {
      for (const t of pollingRef.current.values()) clearInterval(t);
    },
    [],
  );

  if (isLoading || !data) return <Skeleton />;
  const accounts = data.accounts;

  const startPolling = (profileId: number, sessionId: string) => {
    const prevTimer = pollingRef.current.get(profileId);
    if (prevTimer) clearInterval(prevTimer);
    const timer = setInterval(async () => {
      try {
        const st = await api<LoginState>(`/admin/login/${sessionId}`);
        setLoginStates((prev) => ({ ...prev, [profileId]: { ...st, sessionId } }));
        if (st.state === 'done' || st.state === 'timeout' || st.state === 'error' || st.state === 'cancelled') {
          clearInterval(timer);
          pollingRef.current.delete(profileId);
          void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
          void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
        }
      } catch {
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
      }
    }, 2_500);
    pollingRef.current.set(profileId, timer);
  };

  const cancelLogin = async (profileId: number, sessionId: string) => {
    try {
      await api(`/admin/login/${sessionId}/cancel`, { method: 'POST' });
      // 轮询会拉到 cancelled 终态并自行停止;立即置状态给操作者即时反馈
      setLoginStates((prev) => ({
        ...prev,
        [profileId]: { ...(prev[profileId] ?? { viewer: false }), sessionId, state: 'cancelled' as const, detail: '取消中…', updatedAt: new Date().toISOString() },
      }));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const requestLogin = async (id: number) => {
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
      setMessage(`已添加 ${r.created} 个 ${ENGINE_LABELS[newEngine] ?? newEngine} 账号(待登录),逐个点「人工登录」完成扫码`);
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
              {ENGINE_LABELS[s.engine] ?? s.engine}:{s.available}/{s.total} 可用
              {s.pending > 0 && <span className="ml-1 text-warn">(待登录 {s.pending})</span>}
            </span>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">添加账号</h2>
          <select className="input h-9 w-40" value={newEngine} onChange={(e) => setNewEngine(e.target.value)}>
            {WEB_ENGINES.map((e) => (
              <option key={e} value={e}>
                {ENGINE_LABELS[e] ?? e}
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
          系统检测到登录成功后自动入可用池。登录等待上限 5 分钟,超时可重试。
        </p>
      </section>

      {viewerEntries.map(([profileId, st]) => (
        <ViewerPanel key={profileId} sessionId={st.sessionId} />
      ))}

      <section className="card rise-1 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
              <th className="px-5 py-3 font-medium">引擎 / 档案</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">健康分</th>
              <th className="px-5 py-3 font-medium">今日用量</th>
              <th className="px-5 py-3 font-medium">登录态</th>
              <th className="px-5 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-xs text-slate-400">
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
                    <div className="font-medium text-slate-800">{ENGINE_LABELS[a.engine] ?? a.engine}</div>
                    <div className="text-xs text-slate-400">profile #{a.id}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge label={meta.label} tone={meta.tone} />
                  </td>
                  <td className="px-5 py-3 tabular-nums">{a.healthScore}</td>
                  <td className="px-5 py-3 tabular-nums">{a.dailyUsed}</td>
                  <td className="px-5 py-3 text-xs">{a.hasLoginState ? '已注入' : '未注入'}</td>
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
