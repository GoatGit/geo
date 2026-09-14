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
  state: 'queued' | 'running' | 'done' | 'timeout' | 'error';
  detail?: string;
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
  wenxin: '文心一言',
  qwen: '通义千问',
  yuanbao: '腾讯元宝',
};

/**
 * 平台后台 · 账号池人工登录(docs/04 §3.1 账号供给):
 * 登录需要真人扫码/验证码 → 后台登记账号档案后点「人工登录」,
 * worker 弹出真实浏览器窗口,操作者在窗口内完成登录,登录态持久化进账号档案。
 */
export default function AdminAccountsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-accounts'],
    queryFn: () => api<{ accounts: AccountRow[] }>('/admin/accounts'),
    refetchInterval: 15_000,
  });

  const [newEngine, setNewEngine] = useState<string>('doubao');
  const [message, setMessage] = useState('');
  const [loginStates, setLoginStates] = useState<Record<number, LoginState>>({});
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
        setLoginStates((prev) => ({ ...prev, [profileId]: st }));
        if (st.state === 'done' || st.state === 'timeout' || st.state === 'error') {
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
          [profileId]: { state: 'error', detail: '登录会话状态查询失败', updatedAt: new Date().toISOString() },
        }));
      }
    }, 2_500);
    pollingRef.current.set(profileId, timer);
  };

  const requestLogin = async (id: number) => {
    setMessage('');
    try {
      const r = await api<{ sessionId: string }>(`/admin/accounts/${id}/login`, { method: 'POST' });
      setLoginStates((prev) => ({
        ...prev,
        [id]: { state: 'queued', detail: '已提交,等待 worker 打开浏览器…', updatedAt: new Date().toISOString() },
      }));
      startPolling(id, r.sessionId);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const createAccount = async () => {
    setMessage('');
    try {
      await api('/admin/accounts', { method: 'POST', json: { engine: newEngine } });
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
      setMessage(`已登记 ${ENGINE_LABELS[newEngine] ?? newEngine} 账号档案,点「人工登录」完成账号态注入`);
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

  return (
    <>
      <PageHeader
        title="账号池"
        desc="五引擎账号档案与人工登录:登录需真人完成,登录态持久化后由采集 worker 复用"
      />

      <section className="card rise p-6">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">登记新账号</h2>
          <select className="input h-9 w-40" value={newEngine} onChange={(e) => setNewEngine(e.target.value)}>
            {WEB_ENGINES.map((e) => (
              <option key={e} value={e}>
                {ENGINE_LABELS[e] ?? e}
              </option>
            ))}
          </select>
          <button className="btn-primary h-9 px-5" onClick={() => void createAccount()}>
            登记档案
          </button>
          {message && <span className="text-xs text-slate-500">{message}</span>}
        </div>
        <p className="text-xs leading-5 text-slate-500">
          流程:登记档案 → 点该行「人工登录」→ worker 弹出浏览器窗口(BROWSER_MODE=local 或 agentbay)→
          在窗口内完成扫码/验证码 → 系统检测到登录成功后自动入可用池。登录等待上限 5 分钟,超时可重试。
        </p>
      </section>

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
                          st.state === 'done' ? 'text-good' : st.state === 'error' || st.state === 'timeout' ? 'text-bad' : 'text-slate-500'
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
