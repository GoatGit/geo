'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader, Skeleton } from '@/components/ui';
import { WEB_ENGINES, type InsightAgentSettings } from '@geo/shared';

interface SettingsDto {
  schedulerEnabled: boolean;
  globalDailyRunCap: number;
  engineDailyCaps: Record<string, number>;
  proxyPool: { enabled: boolean; key: string };
  insightAgent: InsightAgentSettings;
}

/** POST /admin/insight-agent/test 响应:用当前表单配置(不落库)发一次最小调用 */
interface InsightTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  error?: string;
}

const INSIGHT_MODES: Array<{ value: InsightAgentSettings['mode']; label: string; desc: string }> = [
  { value: 'rules', label: 'rules', desc: '现状:纯规则引擎判定,不发起 LLM 调用' },
  { value: 'shadow', label: 'shadow', desc: '口径走规则,LLM 结果仅存影子对比' },
  { value: 'llm', label: 'llm', desc: 'LLM 判定,失败自动回落规则' },
];

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
 * 平台后台 · 全局配置:调度总开关 / 每日预算 / 代理池 / Insight Agent(LLM 判定层)。
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
  // apiKey 掩码回显:仅当用户输入过新 key 才上传新值,否则传 ''(后端语义 = 保留原值)
  const [insightKeyDirty, setInsightKeyDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<InsightTestResult | null>(null);

  const poolStatus = useQuery({
    queryKey: ['admin-proxy-pool'],
    queryFn: () => api<ProxyPoolStatus>('/admin/proxy-pool/status'),
  });

  useEffect(() => {
    if (data?.settings) {
      setForm({
        ...data.settings,
        engineDailyCaps: { ...data.settings.engineDailyCaps },
        insightAgent: { ...data.settings.insightAgent },
      });
      setInsightKeyDirty(false);
    }
  }, [data]);

  if (isLoading || !form) return <Skeleton />;

  // 客户端提示(不硬阻断):enabled 且 shadow/llm 时连接三项应填全(后端保存时会强校验)
  const insightNeedsConfig =
    form.insightAgent.enabled &&
    form.insightAgent.mode !== 'rules' &&
    (!form.insightAgent.endpoint.trim() || !form.insightAgent.model.trim() || !form.insightAgent.apiKey.trim());

  const testInsight = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 用当前表单值测试(不落库):apiKey 语义与保存一致——空 = 用已存 key
      setTestResult(
        await api<InsightTestResult>('/admin/insight-agent/test', {
          method: 'POST',
          json: {
            insightAgent: {
              ...form.insightAgent,
              apiKey: insightKeyDirty ? form.insightAgent.apiKey : '',
              timeoutMs: Math.min(Math.max(Math.floor(Number(form.insightAgent.timeoutMs) || 0), 2000), 30000),
            },
          },
        }),
      );
    } catch (e) {
      setTestResult({ ok: false, latencyMs: 0, model: '', error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

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
          insightAgent: {
            ...form.insightAgent,
            // 空 / '***' 掩码形态 = 保留原值;仅用户真正输入过新 key 才传新值
            apiKey: insightKeyDirty ? form.insightAgent.apiKey : '',
            timeoutMs: Math.min(Math.max(Math.floor(Number(form.insightAgent.timeoutMs) || 0), 2000), 30000),
          },
        },
      });
      setForm({
        ...r.settings,
        engineDailyCaps: { ...r.settings.engineDailyCaps },
        insightAgent: { ...r.settings.insightAgent },
      });
      setInsightKeyDirty(false);
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
            (() => {
              // 青果接口返回业务错误(如 Key 过期)时显式告警,而不是渲染成"?"空值
              const live = poolStatus.data.live;
              const err = [live.channels, live.inUse, live.whitelist].find(
                (x) => x && typeof x === 'object' && 'code' in x && x.code !== 'SUCCESS',
              ) as { code?: string; message?: string } | undefined;
              if (err) {
                return (
                  <p className="rounded bg-bad-50 px-2 py-1.5 text-bad">
                    青果接口报错:{err.code}(「{err.message ?? '未知'}」)——请到青果控制台确认通道有效期/续费,更新 Key 后 1 分钟内自动生效。
                  </p>
                );
              }
              return (
                <div className="grid gap-1.5">
                  <span>
                    通道:{live.channels?.data?.total ?? '?'} 个(空闲 {live.channels?.data?.idle ?? '?'})
                  </span>
                  {(live.inUse?.data ?? []).length > 0 ? (
                    live.inUse!.data!.map((l) => (
                      <span key={l.server}>
                        当前租约:<b className="metric-num">{l.server}</b>(出口 {l.proxy_ip} · {l.area ?? ''} · 到期 {l.deadline ?? '?'})
                      </span>
                    ))
                  ) : (
                    <span>暂无在用租约(下次采集时自动提取/认领)</span>
                  )}
                  <span>白名单:{(live.whitelist?.Data ?? []).join('、') || '(空)'}</span>
                </div>
              );
            })()
          ) : (
            <p className="text-slate-400">{poolStatus.data?.note ?? '未启用'}</p>
          )}
          <p className="mt-2 text-[10px] text-slate-400">
            注意:沙箱出口 IP 需在青果白名单内;代理 IP 到期后自动提取新 IP,届时需重新登录引擎账号。
          </p>
        </div>
      </section>

      {/* Insight Agent:LLM 判定层(连接配置三项在 shadow/llm + enabled 时为必填,客户端仅提示不阻断) */}
      <section className="card rise p-6">
        <h2 className="mb-1 font-semibold text-slate-900">Insight Agent(LLM 判定层)</h2>
        <p className="mb-4 text-xs leading-5 text-slate-500">
          用 LLM 复核引擎判定结果:关闭后全量走规则引擎(现状行为),不发起任何 LLM 调用。
        </p>
        <div className="mb-4 flex items-center">
          <button
            onClick={() =>
              setForm({ ...form, insightAgent: { ...form.insightAgent, enabled: !form.insightAgent.enabled } })
            }
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              form.insightAgent.enabled ? 'bg-brand-500' : 'bg-slate-300'
            }`}
            aria-pressed={form.insightAgent.enabled}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                form.insightAgent.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className={`ml-3 text-sm font-medium ${form.insightAgent.enabled ? 'text-good' : 'text-slate-500'}`}>
            {form.insightAgent.enabled ? '已启用' : '未启用(全量走规则引擎)'}
          </span>
        </div>

        {/* 模式单选 */}
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {INSIGHT_MODES.map((m) => {
            const active = form.insightAgent.mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                aria-pressed={active}
                onClick={() => setForm({ ...form, insightAgent: { ...form.insightAgent, mode: m.value } })}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  active ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <span className={`block text-xs font-semibold ${active ? 'text-brand-700' : 'text-slate-700'}`}>
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{m.desc}</span>
              </button>
            );
          })}
        </div>

        {/* 连接配置 */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">协议</span>
            <select
              className="input h-10"
              value={form.insightAgent.protocol}
              onChange={(e) =>
                setForm({
                  ...form,
                  insightAgent: { ...form.insightAgent, protocol: e.target.value as InsightAgentSettings['protocol'] },
                })
              }
            >
              <option value="openai">openai(兼容接口)</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">单次调用超时(ms)</span>
            <input
              type="number"
              min={2000}
              max={30000}
              step={500}
              className="input metric-num h-10"
              value={form.insightAgent.timeoutMs}
              onChange={(e) =>
                setForm({ ...form, insightAgent: { ...form.insightAgent, timeoutMs: Number(e.target.value) } })
              }
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600">Endpoint</span>
            <input
              type="text"
              className="input h-10"
              placeholder="https://api.example.com/v1(须 https;openai 兼容填到 /v1,anthropic 填网关基址)"
              value={form.insightAgent.endpoint}
              onChange={(e) => setForm({ ...form, insightAgent: { ...form.insightAgent, endpoint: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">API Key</span>
            <input
              type="password"
              autoComplete="new-password"
              className="input h-10"
              placeholder="留空保留原 key"
              value={form.insightAgent.apiKey}
              onChange={(e) => {
                setInsightKeyDirty(true);
                setForm({ ...form, insightAgent: { ...form.insightAgent, apiKey: e.target.value } });
              }}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Model</span>
            <input
              type="text"
              className="input h-10"
              placeholder="如 gpt-4o-mini"
              value={form.insightAgent.model}
              onChange={(e) => setForm({ ...form, insightAgent: { ...form.insightAgent, model: e.target.value } })}
            />
          </label>
        </div>

        {insightNeedsConfig && (
          <p className="mt-3 text-xs text-warn">
            已启用 {form.insightAgent.mode} 模式:endpoint / apiKey / model 应填全,否则保存时后端会拒绝。
          </p>
        )}

        {/* 连通性测试(用当前表单值,不落库) */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-soft h-9 px-4 text-xs disabled:opacity-50" disabled={testing} onClick={() => void testInsight()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {testResult &&
            (testResult.ok ? (
              <span className="text-xs text-good">
                连接正常 · {testResult.latencyMs}ms · {testResult.model || '—'}
              </span>
            ) : (
              <span className="text-xs text-bad">失败:{testResult.error ?? '未知错误'}</span>
            ))}
          <span className="text-[10px] text-slate-400">用当前表单配置测试(不会保存);API Key 留空 = 用已保存的 key</span>
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
