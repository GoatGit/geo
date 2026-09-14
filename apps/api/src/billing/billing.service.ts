import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import QRCode from 'qrcode';
import { creditLedger, orders, subscriptions } from '@geo/db';
import {
  BILLING_PERIODS,
  PLAN_LABELS,
  PLAN_LIMITS,
  PLAN_PRICING,
  PURCHASABLE_PLANS,
  type BillingPeriod,
  type PayChannel,
  type PlanTier,
} from '@geo/shared';
import { DB } from '../common/infra.module';
import { loadEnv } from '../config/env';
import type { NotifyVerifyResult, PaymentProvider } from './payment-provider';
import { WechatPayProvider } from './wechat-pay';
import { AlipayProvider } from './alipay';

/** 档位权重:同账号多笔有效订单叠加时取最高档位(升级不降级)。 */
const PLAN_RANK: Record<PlanTier, number> = { free: 0, starter: 1, standard: 2, pro: 3, custom: 4 };

const PERIOD_DAYS: Record<BillingPeriod, number> = { monthly: 30, yearly: 365 };

/**
 * 会员有效期解析(纯函数,可测):paid 订单 → 生效窗口;
 * 多笔叠加取最高档位,过期时间取该档位内最晚者。口径:窗口 = paid_at + PERIOD_DAYS。
 */
export function resolveMembership(
  paid: Array<{ plan: string; period: string; paidAt: Date }>,
  now = new Date(),
): { plan: PlanTier; expiresAt: Date | null } {
  const windows = paid
    .filter((o) => o.period in PERIOD_DAYS)
    .map((o) => ({
      plan: o.plan as PlanTier,
      paidAt: o.paidAt,
      expiresAt: new Date(o.paidAt.getTime() + PERIOD_DAYS[o.period as BillingPeriod] * 24 * 3600 * 1000),
    }))
    .filter((w) => w.expiresAt.getTime() > now.getTime());
  if (windows.length === 0) return { plan: 'free', expiresAt: null };
  const top = Math.max(...windows.map((w) => PLAN_RANK[w.plan] ?? 0));
  const best = windows.filter((w) => (PLAN_RANK[w.plan] ?? 0) === top);
  return { plan: best[0]!.plan, expiresAt: new Date(Math.max(...best.map((w) => w.expiresAt.getTime()))) };
}

/** 续费不缩水:已有有效期未结束时从其基础上顺延,否则从当前时间起算(纯函数,可测)。 */
export function nextPeriodEnd(current: Date | null, period: BillingPeriod, now = new Date()): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + PERIOD_DAYS[period] * 24 * 3600 * 1000);
}

/**
 * 会员计划与支付(docs/01 §3.10 账户与套餐,docs/02 §7 商业化):
 * 下单(渠道抽象)→ 渠道回调验签 → orders 状态机 → 账号会员生效 + 全部品牌订阅刷新。
 * 渠道密钥未配置时:dev 降级 mock 通道(可视化模拟支付);生产显式 503,不静默。
 */
@Injectable()
export class BillingService {
  private readonly wechat = new WechatPayProvider();
  private readonly alipay = new AlipayProvider();

  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  /** 渠道解析:优先真实渠道;dev 未配置降级 mock;生产未配置显式失败。 */
  private providerFor(channel: Exclude<PayChannel, 'mock'>): PaymentProvider {
    const wanted: PaymentProvider = channel === 'wechat' ? this.wechat : this.alipay;
    if (wanted.configured) return wanted;
    if (loadEnv().nodeEnv !== 'production') {
      return {
        channel: 'mock',
        configured: true,
        async createOrder() {
          return { codeUrl: null, channelTradeId: null, raw: { fallback: `${channel}_not_configured` } };
        },
        async verifyNotify(): Promise<NotifyVerifyResult> {
          return { ok: false, outTradeNo: null, channelTradeId: null, amountCents: null, paid: false, raw: {}, ackBody: 'fail' };
        },
      };
    }
    throw new HttpException(
      `${channel === 'wechat' ? '微信支付' : '支付宝'}未配置(生产环境不提供 mock 通道)`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /** 套餐目录(定价口径 @geo/shared 单一事实源)。 */
  plans() {
    return PURCHASABLE_PLANS.map((plan) => ({
      plan: plan as PlanTier,
      label: PLAN_LABELS[plan],
      pricing: PLAN_PRICING[plan],
      limits: PLAN_LIMITS[plan],
    }));
  }

  /** 账号会员状态:paid 订单窗口解析 + 品牌订阅行(配额执行点)+ 积分余额。 */
  async subscriptionStatus(accountId: number) {
    const membership = await this.accountMembership(accountId);
    const subs = await this.db.select().from(subscriptions).where(eq(subscriptions.accountId, accountId));
    const ledger = await this.db
      .select({ balanceAfter: creditLedger.balanceAfter })
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(1);
    return {
      plan: membership.plan,
      planLabel: PLAN_LABELS[membership.plan],
      expiresAt: membership.expiresAt,
      credits: ledger[0]?.balanceAfter ?? 0,
      subscriptions: subs.map((s) => ({
        brandId: s.brandId,
        plan: s.plan as PlanTier,
        questionQuota: s.questionQuota,
        engineQuota: s.engineQuota,
        periodEnd: s.periodEnd,
        status: s.status,
      })),
    };
  }

  async accountMembership(accountId: number): Promise<{ plan: PlanTier; expiresAt: Date | null }> {
    const paid = await this.db
      .select({ plan: orders.plan, period: orders.period, paidAt: orders.paidAt })
      .from(orders)
      .where(and(eq(orders.accountId, accountId), eq(orders.status, 'paid')))
      .orderBy(desc(orders.paidAt))
      .limit(100);
    return resolveMembership(
      paid.map((r) => ({ plan: r.plan, period: r.period, paidAt: r.paidAt ?? new Date(0) })),
    );
  }

  async createOrder(
    accountId: number,
    input: { plan: PlanTier; period: BillingPeriod; channel: Exclude<PayChannel, 'mock'> },
  ) {
    if (!PURCHASABLE_PLANS.includes(input.plan as (typeof PURCHASABLE_PLANS)[number])) {
      throw new HttpException(`档位不可购买: ${input.plan}`, HttpStatus.BAD_REQUEST);
    }
    if (!BILLING_PERIODS.includes(input.period) || (input.channel as string) === 'mock') {
      throw new HttpException('period 或 channel 非法', HttpStatus.BAD_REQUEST);
    }

    const provider = this.providerFor(input.channel);
    const amountCents = PLAN_PRICING[input.plan as Exclude<PlanTier, 'free' | 'custom'>][input.period];
    const outTradeNo = `GL${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;
    const expireAt = new Date(Date.now() + 2 * 3600 * 1000);
    const env = loadEnv();
    const notifyBase = env.publicBaseUrl ? `${env.publicBaseUrl.replace(/\/$/, '')}/billing/notify` : '';

    const channelOrder = await provider.createOrder({
      outTradeNo,
      amountCents,
      subject: `GeoLens ${PLAN_LABELS[input.plan]}会员 · ${input.period === 'yearly' ? '年付' : '月付'}`,
      notifyUrl: provider.channel === 'mock' || !notifyBase ? undefined : `${notifyBase}/${provider.channel}`,
      returnUrl:
        input.channel === 'alipay' && notifyBase
          ? `${env.publicBaseUrl!.replace(/\/$/, '')}/billing?paid=${outTradeNo}`
          : undefined,
      expireAt: expireAt.toISOString(),
    });

    const qrDataUrl = channelOrder.codeUrl ? await QRCode.toDataURL(channelOrder.codeUrl, { margin: 1, width: 280 }) : null;
    const row = (
      await this.db
        .insert(orders)
        .values({
          outTradeNo,
          accountId,
          product: 'plan',
          plan: input.plan,
          period: input.period,
          channel: provider.channel,
          amountCents,
          status: 'created',
          payUrl: channelOrder.codeUrl,
          expireAt,
          meta: {
            requestedChannel: input.channel,
            ...(qrDataUrl ? { qrDataUrl } : {}),
            channelRaw: channelOrder.raw,
          },
        })
        .returning()
    )[0]!;

    return {
      orderId: row.id,
      outTradeNo,
      plan: input.plan,
      period: input.period,
      channel: provider.channel,
      amountCents,
      mock: provider.channel === 'mock',
      qrDataUrl,
      payUrl: channelOrder.codeUrl,
      expireAt,
    };
  }

  async orderOf(accountId: number, orderId: number) {
    const row = (
      await this.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.accountId, accountId)))
        .limit(1)
    )[0];
    if (!row) throw new HttpException('订单不存在', HttpStatus.NOT_FOUND);
    return {
      orderId: row.id,
      outTradeNo: row.outTradeNo,
      plan: row.plan as PlanTier,
      period: row.period as BillingPeriod,
      channel: row.channel,
      amountCents: row.amountCents,
      status: row.status,
      qrDataUrl: (row.meta as Record<string, string>).qrDataUrl ?? null,
      paidAt: row.paidAt,
      createdAt: row.createdAt,
    };
  }

  async ordersOf(accountId: number) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.accountId, accountId))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return rows.map((r) => ({
      orderId: r.id,
      outTradeNo: r.outTradeNo,
      plan: r.plan as PlanTier,
      planLabel: PLAN_LABELS[r.plan as PlanTier] ?? r.plan,
      period: r.period as BillingPeriod,
      channel: r.channel,
      amountCents: r.amountCents,
      status: r.status,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }));
  }

  /** dev 模拟支付:mock 通道专用,生产路由层直接拒绝。 */
  async mockPay(accountId: number, orderId: number) {
    const row = await this.orderOf(accountId, orderId);
    if (row.channel !== 'mock') throw new HttpException('仅 mock 通道可模拟支付', HttpStatus.BAD_REQUEST);
    if (row.status !== 'created') throw new HttpException(`订单状态不可支付: ${row.status}`, HttpStatus.CONFLICT);
    const order = (await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0]!;
    await this.settle(order, `mock-${orderId}`, order.amountCents);
    return this.orderOf(accountId, orderId);
  }

  async handleWechatNotify(headers: Record<string, string>, rawBody: string): Promise<{ status: number; body: string }> {
    const result = await this.wechat.verifyNotify(headers, rawBody, {});
    if (!result.ok) return { status: HttpStatus.UNAUTHORIZED, body: '{"code":"FAIL","message":"验签失败"}' };
    if (result.paid && result.outTradeNo) {
      await this.settleByOutTradeNo(result.outTradeNo, 'wechat', result.channelTradeId, result.amountCents);
    }
    return { status: HttpStatus.OK, body: result.ackBody };
  }

  async handleAlipayNotify(body: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const result = await this.alipay.verifyNotify({}, '', body);
    if (!result.ok) return { status: HttpStatus.UNAUTHORIZED, body: 'fail' };
    if (result.paid && result.outTradeNo) {
      await this.settleByOutTradeNo(result.outTradeNo, 'alipay', result.channelTradeId, result.amountCents);
    }
    return { status: HttpStatus.OK, body: result.ackBody };
  }

  private async settleByOutTradeNo(
    outTradeNo: string,
    channel: 'wechat' | 'alipay',
    channelTradeId: string | null,
    amountCents: number | null,
  ) {
    const order = (await this.db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo)).limit(1))[0];
    if (!order || order.channel !== channel) return;
    await this.settle(order, channelTradeId, amountCents);
  }

  /**
   * 发货(幂等):created → paid 原子流转(已支付行由触发器保护,不可二次变更);
   * 金额与订单不一致时拒绝发货并保留 created 供人工对账(docs/02 §7.2 流水对账口径)。
   */
  private async settle(order: typeof orders.$inferSelect, channelTradeId: string | null, amountCents: number | null) {
    if (amountCents !== null && amountCents !== order.amountCents) {
      console.error(`[billing] amount mismatch: order ${order.outTradeNo} expect ${order.amountCents} got ${amountCents}`);
      throw new HttpException('回调金额与订单不一致', HttpStatus.CONFLICT);
    }
    const claimed = await this.db
      .update(orders)
      .set({ status: 'paid', channelTradeId, paidAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, 'created')))
      .returning({ id: orders.id });
    if (claimed.length === 0) return;

    const plan = order.plan as PlanTier;
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    const now = new Date();
    // 会员为账号级:名下全部活跃品牌订阅统一刷新(配额执行点在 subscriptions 行)
    const subs = await this.db.select().from(subscriptions).where(eq(subscriptions.accountId, order.accountId));
    for (const s of subs) {
      if (s.status !== 'active') continue;
      await this.db
        .update(subscriptions)
        .set({
          plan,
          questionQuota: { ranking: limits.rankingQuota, reputation: limits.reputationQuota },
          engineQuota: { web: limits.webEngines, app: limits.appEngines },
          periodEnd: nextPeriodEnd(s.periodEnd, order.period as BillingPeriod, now),
        })
        .where(eq(subscriptions.id, s.id));
    }
  }
}
