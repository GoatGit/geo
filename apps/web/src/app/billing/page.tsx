'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/queries';
import type { BillingPeriod, PlanTier } from '@geo/shared';
import { BOOSTER_PACK } from '@geo/shared';

/**
 * 套餐与账单(docs/01 §3.10 ⑦ 账户与套餐):
 * 当前档位 + 档位对比(月/年付)+ 下单(微信/支付宝二维码)+ 支付轮询 + 账单列表。
 * 渠道未配置密钥时 dev 降级 mock 通道,页面显示「模拟支付」按钮走通全流程。
 */

interface PlanCatalogItem {
  plan: PlanTier;
  label: string;
  pricing: { monthly: number; yearly: number };
  limits: {
    rankingQuota: number;
    reputationQuota: number;
    webEngines: number;
    historyDays: number;
    weeklyReport: boolean;
    monthlyReport: boolean;
    multiBrand: number;
  };
}

interface SubscriptionDto {
  plan: PlanTier;
  planLabel: string;
  expiresAt: string | null;
  credits: number;
  packs?: { purchased: number; extraRanking: number; extraReputation: number; latestPaidAt: string | null };
  subscriptions: Array<{ brandId: number; plan: PlanTier; periodEnd: string | null; status: string }>;
}

interface OrderRow {
  orderId: number;
  outTradeNo: string;
  planLabel: string;
  period: BillingPeriod;
  channel: string;
  amountCents: number;
  status: string;
  paidAt: string | null;
  createdAt: string;
}

interface OrderDetail extends OrderRow {
  qrDataUrl: string | null;
  mock: boolean;
  expireAt: string;
}

const CHANNEL_LABEL: Record<string, string> = { wechat: '微信支付', alipay: '支付宝', mock: '模拟通道' };
const STATUS_LABEL: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'slate' }> = {
  paid: { label: '已支付', tone: 'good' },
  created: { label: '待支付', tone: 'warn' },
  failed: { label: '失败', tone: 'bad' },
  refunded: { label: '已退款', tone: 'slate' },
  expired: { label: '已过期', tone: 'slate' },
};

const yuan = (cents: number) => (cents % 100 === 0 ? `${cents / 100}` : (cents / 100).toFixed(2));
const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export default function BillingPage() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [activeOrder, setActiveOrder] = useState<OrderDetail | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [creating, setCreating] = useState<PlanTier | 'booster10' | null>(null);

  const plans = useQuery({ queryKey: ['billing-plans'], queryFn: () => api<PlanCatalogItem[]>('/billing/plans') });
  const subscription = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => api<SubscriptionDto>('/billing/subscription'),
  });
  const orders = useQuery({ queryKey: ['billing-orders'], queryFn: () => api<OrderRow[]>('/billing/orders') });

  // 支付中订单轮询:created 状态每 3s 查一次(sync 端点同时向渠道对账,回调丢失兜底),
  // paid 后刷新会员与账单并自动收起支付弹窗
  const orderPoll = useQuery({
    queryKey: ['billing-order', activeOrder?.orderId],
    queryFn: () => api<OrderDetail>(`/billing/orders/${activeOrder!.orderId}/sync`),
    enabled: activeOrder !== null && activeOrder.status === 'created',
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (orderPoll.data && orderPoll.data.status !== activeOrder?.status) {
      setActiveOrder(orderPoll.data);
      if (orderPoll.data.status === 'paid') {
        void queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
        void queryClient.invalidateQueries({ queryKey: ['billing-orders'] });
      }
    }
  }, [orderPoll.data, activeOrder?.status, queryClient]);

  // 落地页 /billing?plan=xxx 进入时无需预选:每张档位卡自带支付按钮,周期默认月付

  const purchase = async (plan: PlanTier | 'booster10', channel: 'wechat' | 'alipay') => {
    setPayError(null);
    setCreating(plan);
    try {
      const order = await api<OrderDetail>('/billing/orders', {
        method: 'POST',
        json: { plan, period, channel },
      });
      setActiveOrder(order);
    } catch (err) {
      setPayError((err as Error).message);
    } finally {
      setCreating(null);
    }
  };

  const mockPay = async () => {
    if (!activeOrder) return;
    setPayError(null);
    try {
      const paid = await api<OrderDetail>(`/billing/orders/${activeOrder.orderId}/mock-pay`, { method: 'POST' });
      setActiveOrder(paid);
      void queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['billing-orders'] });
    } catch (err) {
      setPayError((err as Error).message);
    }
  };

  const currentPlan = subscription.data?.plan ?? 'free';
  const currentRank = useMemo(() => ['free', 'starter', 'standard', 'pro', 'custom'].indexOf(currentPlan), [currentPlan]);

  if (plans.isLoading || subscription.isLoading) return <Skeleton />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <>
            套餐与账单
            <Badge
              label={`当前:${subscription.data?.planLabel ?? '免费版'}`}
              tone={currentRank > 0 ? 'brand' : 'slate'}
            />
          </>
        }
        actions={
          subscription.data?.expiresAt ? (
            <span className="text-xs text-slate-500">
              会员有效期至 <b className="metric-num text-slate-700">{fmt(subscription.data.expiresAt)}</b> · 积分余额{' '}
              <b className="metric-num text-slate-700">{subscription.data.credits}</b>
              {subscription.data.packs && subscription.data.packs.purchased > 0 && (
                <>
                  {' '}· <span className="whitespace-nowrap text-brand-700">
                    资源包 ×{subscription.data.packs.purchased}(加额 排名 +{subscription.data.packs.extraRanking} / 口碑 +
                    {subscription.data.packs.extraReputation})
                  </span>
                </>
              )}
            </span>
          ) : undefined
        }
      />

      {/* 周期切换 */}
      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs font-medium shadow-sm w-fit">
        {(['monthly', 'yearly'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-md px-3 py-1.5 transition-colors ${period === p ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {p === 'monthly' ? '月付' : '年付 · 立省约 17%'}
          </button>
        ))}
      </div>

      {payError && (
        <p className="rounded-lg bg-bad-50 px-3.5 py-2.5 text-xs text-bad">下单失败:{payError}</p>
      )}

      {/* 档位卡 */}
      <section className="grid gap-4 lg:grid-cols-3">
        {(plans.data ?? []).map((p) => {
          const isCurrent = p.plan === currentPlan;
          const price = period === 'monthly' ? p.pricing.monthly : p.pricing.yearly;
          const perMonth = period === 'yearly' ? Math.round(p.pricing.yearly / 12) : p.pricing.monthly;
          return (
            <div
              key={p.plan}
              className={`card flex flex-col p-6 ${isCurrent ? 'border-brand-400 ring-1 ring-brand-200' : ''}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-500">{p.label}</h3>
                {isCurrent && <Badge label="当前档位" tone="brand" />}
              </div>
              <p className="mt-2">
                <span className="metric-num text-3xl font-semibold text-slate-900">¥{yuan(price)}</span>
                <span className="text-sm text-slate-400">/{period === 'monthly' ? '月' : '年'}</span>
                {period === 'yearly' && <span className="ml-2 text-xs text-slate-400">约 ¥{yuan(perMonth)}/月</span>}
              </p>
              <ul className="mt-4 flex-1 space-y-1.5 text-[13px] leading-5 text-slate-600">
                <li>· 排名词 {p.limits.rankingQuota} + 口碑词 {p.limits.reputationQuota}</li>
                <li>· 网页端 {p.limits.webEngines} 引擎 · 每日 1 轮</li>
                <li>· {p.limits.weeklyReport ? (p.limits.monthlyReport ? '周报 + 月报' : '周报') : '—'}</li>
                <li>· 历史留存 {p.limits.historyDays} 天 · 品牌 ×{p.limits.multiBrand}</li>
              </ul>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  onClick={() => purchase(p.plan, 'wechat')}
                  disabled={creating !== null}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {creating === p.plan ? '下单中…' : '微信支付'}
                </button>
                <button
                  onClick={() => purchase(p.plan, 'alipay')}
                  disabled={creating !== null}
                  className="btn-ghost w-full disabled:opacity-50"
                >
                  支付宝
                </button>
              </div>
            </div>
          );
        })}
      </section>

      {/* 一次性资源包 */}
      <section className="card flex flex-col items-start gap-4 border-brand-200 bg-gradient-to-br from-brand-50/60 to-white p-6 sm:flex-row sm:items-center">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-900">{BOOSTER_PACK.label}</h3>
            <Badge label="一次性" tone="brand" />
          </div>
          <p className="mt-1 text-xs text-slate-500">无需订阅,买一次用一次:30 天窗口内完成一轮完整监测。</p>
          <ul className="mt-3 space-y-1 text-[13px] leading-5 text-slate-600">
            {BOOSTER_PACK.perks.map((perk) => (
              <li key={perk}>· {perk}</li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-36">
          <p className="text-center">
            <span className="metric-num text-2xl font-semibold text-slate-900">¥{BOOSTER_PACK.priceFen / 100}</span>
          </p>
          <button
            onClick={() => purchase(BOOSTER_PACK.id, 'wechat')}
            disabled={creating !== null}
            className="btn-primary w-full disabled:opacity-50"
          >
            {creating === BOOSTER_PACK.id ? '下单中…' : '微信支付'}
          </button>
        </div>
      </section>

      {/* 账单 */}
      <section className="card p-4 md:p-6">
        <h2 className="mb-4 font-semibold text-slate-900">账单记录</h2>
        {(orders.data ?? []).length === 0 ? (
          <EmptyState text="还没有订单:选择上方档位即可升级会员,支付后配额立即生效。" />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400">
                <th className="py-2 font-medium">订单号</th>
                <th className="py-2 font-medium">档位</th>
                <th className="py-2 font-medium">周期</th>
                <th className="py-2 font-medium">渠道</th>
                <th className="py-2 font-medium text-right">金额</th>
                <th className="py-2 font-medium">状态</th>
                <th className="py-2 font-medium text-right">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((o) => {
                const st = STATUS_LABEL[o.status] ?? { label: o.status, tone: 'slate' as const };
                return (
                  <tr key={o.orderId} className="border-b border-slate-50 text-slate-600">
                    <td className="metric-num py-2.5 text-xs text-slate-400">{o.outTradeNo}</td>
                    <td className="py-2.5">{o.planLabel}</td>
                    <td className="py-2.5">{o.period === 'yearly' ? '年付' : '月付'}</td>
                    <td className="py-2.5">{CHANNEL_LABEL[o.channel] ?? o.channel}</td>
                    <td className="metric-num py-2.5 text-right text-slate-800">¥{yuan(o.amountCents)}</td>
                    <td className="py-2.5">
                      <Badge label={st.label} tone={st.tone} />
                    </td>
                    <td className="py-2.5 text-right text-xs text-slate-400">{fmt(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {/* 支付弹窗 */}
      {activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm" onClick={() => activeOrder.status === 'paid' && setActiveOrder(null)}>
          <div className="card w-[340px] p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-900">
              {activeOrder.planLabel}会员 · {activeOrder.period === 'yearly' ? '年付' : '月付'}
            </h3>
            <p className="metric-num mt-1 text-2xl font-semibold text-slate-900">¥{yuan(activeOrder.amountCents)}</p>

            {activeOrder.status === 'paid' ? (
              <div className="py-8">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-good-50 text-good">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="m4 12.5 5 5L20 6.5" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-good">支付成功,配额已生效</p>
                <button onClick={() => setActiveOrder(null)} className="btn-primary mt-5 w-full">
                  完成
                </button>
              </div>
            ) : (
              <>
                {activeOrder.qrDataUrl ? (
                  <div className="mx-auto mt-4 w-fit rounded-xl border border-slate-100 bg-white p-2">
                    {/* 服务端签发的收银台二维码(data URL),扫码后由渠道异步回调发货 */}
                                  <img src={activeOrder.qrDataUrl} alt="支付二维码" width={216} height={216} />
                  </div>
                ) : (
                  <p className="mt-6 rounded-lg bg-slate-50 px-3 py-4 text-xs leading-5 text-slate-500">
                    dev 环境:支付渠道密钥未配置,已降级模拟通道。
                  </p>
                )}
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-brand-500" />
                  使用{CHANNEL_LABEL[activeOrder.channel] ?? '渠道'}扫码支付,支付后自动到账
                </p>
                {activeOrder.mock && (
                  <button onClick={mockPay} className="btn-ghost mt-3 w-full text-xs">
                    [dev] 模拟支付成功
                  </button>
                )}
                {payError && <p className="mt-2 text-xs text-bad">{payError}</p>}
                <button onClick={() => setActiveOrder(null)} className="mt-3 text-xs text-slate-400 hover:text-slate-600">
                  暂不支付
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
