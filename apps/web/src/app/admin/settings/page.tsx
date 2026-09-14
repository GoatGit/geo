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
      setMessage('已保存,下一调度周期生效');
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

      <div className="flex items-center gap-3">
        <button className="btn-primary h-10 px-6 disabled:opacity-50" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存配置'}
        </button>
        {message && <span className="text-xs text-slate-500">{message}</span>}
      </div>
    </>
  );
}
