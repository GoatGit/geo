'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader, Skeleton } from '@/components/ui';
import { WEB_ENGINES } from '@geo/shared';

interface SettingsDto {
  schedulerEnabled: boolean;
  globalDailyRunCap: number;
  engineDailyCaps: Record<string, number>;
  proxyPool: { enabled: boolean; key: string };
}

interface ProxyPoolStatus {
  settings: { enabled: boolean; key: string };
  live: {
    channels: { data?: { total?: number; idle?: number }; code?: string; raw?: string };
    inUse: { data?: Array<{ server: string; proxy_ip: string; area?: string; deadline?: string }>; code?: string; raw?: string };
    whitelist: { Data?: string[] };
  } | null;
  note?: string;
}

/**
 * 平台后台 · 全局配置:调度总开关 / 全局每日任务上限 / 每引擎每日上限。
 * 保存后下一调度 tick 生效(调度器每分钟读库),无需重启 worker。
 */
export default function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ settings: SettingsDto }>('/admin/settings'),
  });

  const [form, setForm] = useState<SettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const poolStatus = useQuery({
    queryKey: ['admin-proxy-pool'],
    queryFn: () => api<ProxyPoolStatus>('/admin/proxy-pool/status'),
  });

  useEffect(() => {
    if (data?.settings) setForm({ ...data.settings, engineDailyCaps: { ...data.settings.engineDailyCaps } });
  }, [data]);

  if (isLoading || !form) return <Skeleton />;

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const r = await api<{ settings: SettingsDto }>('/admin/settings', {
        method: 'PUT',
        json: {
          schedulerEnabled: form.schedulerEnabled,
          globalDailyRunCap: Math.max(0, Math.floor(Number(form.globalDailyRunCap) || 0)),
          engineDailyCaps: Object.fromEntries(
            WEB_ENGINES.map((e) => [e, Math.max(0, Math.floor(Number(form.engineDailyCaps[e]) || 0))]),
          ),
        },
      });
      setForm({ ...r.settings, engineDailyCaps: { ...r.settings.engineDailyCaps } });
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-proxy-pool'] });
      setMessage('已保存:调度项下一周期生效,代理池 1 分钟内热加载');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="全局配置" desc="平台级采集约束:总开关与每日任务预算,对全部品牌生效" />

      <section className="card rise p-6">
        <h2 className="mb-1 font-semibold text-slate-900">调度总开关</h2>
        <p className="mb-4 text-xs leading-5 text-slate-500">
          停用后轮次调度器不再派发新任务,在途任务正常完成;用于引擎故障或账号池补给时快速止血。
        </p>
        <button
          onClick={() => setForm({ ...form, schedulerEnabled: !form.schedulerEnabled })}
          className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
            form.schedulerEnabled ? 'bg-brand-500' : 'bg-slate-300'
          }`}
          aria-pressed={form.schedulerEnabled}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              form.schedulerEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className={`ml-3 text-sm font-medium ${form.schedulerEnabled ? 'text-good' : 'text-bad'}`}>
          {form.schedulerEnabled ? '调度中' : '已停用(kill switch)'}
        </span>
      </section>

      <section className="card rise-1 p-6">
        <h2 className="mb-1 font-semibold text-slate-900">全局每日任务上限</h2>
        <p className="mb-4 text-xs leading-5 text-slate-500">
          全平台单日 QueryRun 总量上限(自然日),0 = 不限。装不下的轮次按实际入队截断,次日预算恢复后续派。
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            className="input h-10 w-40"
            value={form.globalDailyRunCap}
            onChange={(e) => setForm({ ...form, globalDailyRunCap: Number(e.target.value) })}
          />
          <span className="text-xs text-slate-500">条 / 日</span>
        </div>
      </section>

      <section className="card rise-2 p-6">
        <h2 className="mb-1 font-semibold text-slate-900">每引擎每日上限</h2>
        <p className="mb-4 text-xs leading-5 text-slate-500">
          控制单引擎的采集量以对齐其配额与风控水位,0 = 不限。
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {WEB_ENGINES.map((engine) => (
            <label key={engine} className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">{engine}</span>
              <input
                type="number"
                min={0}
                className="input h-10 w-full"
                value={form.engineDailyCaps[engine] ?? 0}
                onChange={(e) =>
                  setForm({
                    ...form,
                    engineDailyCaps: { ...form.engineDailyCaps, [engine]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
        </div>
      </section>

      <section className="card rise-3 p-6">
        <h2 className="mb-1 font-semibold text-slate-900">代理池(青果网络长效代理)</h2>
        <p className="mb-4 text-xs leading-5 text-slate-500">
          登录与采集共用一个稳定长效代理出口 IP,Cookie 与出口 IP 绑定一致(根治登录态跨 IP 失效)。
          保存后 worker 1 分钟内热加载,无需重启。
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={() => setForm({ ...form, proxyPool: { ...form.proxyPool, enabled: !form.proxyPool.enabled } })}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              form.proxyPool.enabled ? 'bg-brand-500' : 'bg-slate-300'
            }`}
            aria-pressed={form.proxyPool.enabled}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                form.proxyPool.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className={`text-sm font-medium ${form.proxyPool.enabled ? 'text-good' : 'text-slate-500'}`}>
            {form.proxyPool.enabled ? '已启用' : '未启用(直连)'}
          </span>
          <label className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-600">青果 Key</span>
            <input
              type="text"
              className="input metric-num h-10 w-64"
              placeholder="提取链接中的 key= 参数"
              value={form.proxyPool.key}
              onChange={(e) => setForm({ ...form, proxyPool: { ...form.proxyPool, key: e.target.value } })}
            />
          </label>
        </div>

        {/* 实时状态 */}
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-4 text-xs leading-6 text-slate-600">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-slate-700">实时状态</span>
            <button className="text-brand-600 hover:underline" onClick={() => void poolStatus.refetch()}>
              刷新
            </button>
          </div>
          {poolStatus.isLoading ? (
            <p className="text-slate-400">加载中…</p>
          ) : poolStatus.data?.live ? (
            <div className="grid gap-1.5">
              <span>
                通道:{poolStatus.data.live.channels?.data?.total ?? '?'} 个(空闲 {poolStatus.data.live.channels?.data?.idle ?? '?'})
              </span>
              {(poolStatus.data.live.inUse?.data ?? []).length > 0 ? (
                poolStatus.data.live.inUse!.data!.map((l) => (
                  <span key={l.server}>
                    当前租约:<b className="metric-num">{l.server}</b>(出口 {l.proxy_ip} · {l.area ?? ''} · 到期 {l.deadline ?? '?'})
                  </span>
                ))
              ) : (
                <span>暂无在用租约(下次采集时自动提取/认领)</span>
              )}
              <span>白名单:{(poolStatus.data.live.whitelist?.Data ?? []).join('、') || '(空)'}</span>
            </div>
          ) : (
            <p className="text-slate-400">{poolStatus.data?.note ?? '未启用'}</p>
          )}
          <p className="mt-2 text-[10px] text-slate-400">
            注意:沙箱出口 IP 需在青果白名单内;代理 IP 到期后自动提取新 IP,届时需重新登录引擎账号。
          </p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button className="btn-primary h-10 px-6 disabled:opacity-50" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存配置'}
        </button>
        {message && <span className="text-xs text-slate-500">{message}</span>}
      </div>
    </>
  );
}
