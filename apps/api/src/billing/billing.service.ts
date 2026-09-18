import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import QRCode from 'qrcode';
import { creditLedger, collectionPlans, orders, subscriptions } from '@geo/db';
import {
  BILLING_PERIODS,
  PLAN_LABELS,
  PLAN_LIMITS,
  PLAN_PRICING,
  PURCHASABLE_PLANS,
  WEB_ENGINES,
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
 * 会员有效期解析(纯函数,可测):paid 订单 → 生效窗口。
 * 同档位续费链式顺延(与订阅行 nextPeriodEnd 同一口径:未过期从现有到期日上加,
 * 已过期从购买时间起算),再按档位取最高——消除"每笔独立开窗取最晚"导致的
 * 提前续费权益缩水(9/1 月付 + 9/10 续费应为 10/31,独立开窗只算到 10/10)。
 */
export function resolveMembership(
  paid: Array<{ plan: string; period: string; paidAt: Date }>,
  now = new Date(),
): { plan: PlanTier; expiresAt: Date | null } {
  const chainEndByPlan = new Map<PlanTier, number>();
  const chronological = paid
    .filter((o) => o.period in PERIOD_DAYS && o.plan in PLAN_RANK)
    .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
  for (const o of chronological) {
    const plan = o.plan as PlanTier;
    const prevEnd = chainEndByPlan.get(plan) ?? 0;
    const base = Math.max(prevEnd, o.paidAt.getTime());
    chainEndByPlan.set(plan, base + PERIOD_DAYS[o.period as BillingPeriod] * 24 * 3600 * 1000);
  }

  const nowMs = now.getTime();
  let top: PlanTier | null = null;
  let topEnd = 0;
  for (const [plan, end] of chainEndByPlan) {
    if (end <= nowMs) continue; // 该档位续费链已整体过期
    if (top === null || PLAN_RANK[plan] > PLAN_RANK[top]) {
      top = plan;
      topEnd = end;
    } else if (plan !== top && PLAN_RANK[plan] === PLAN_RANK[top]) {
      topEnd = Math.max(topEnd, end);
    }
  }
  return top ? { plan: top, expiresAt: new Date(topEnd) } : { plan: 'free', expiresAt: null };
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
    // 商户单号:时间戳 + 8 位随机(微信要求 6-32 位字母数字;撞唯一约束会 500 拒绝下单)
    const outTradeNo = `GL${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const expireAt = new Date(Date.now() + 2 * 3600 * 1000);
    const env = loadEnv();
    const notifyBase = env.publicBaseUrl ? `${env.publicBaseUrl.replace(/\/$/, '')}/billing/notify` : '';

    const channelOrder = await provider.createOrder({
      outTradeNo,
      amountCents,
      subject: `青柠GEO ${PLAN_LABELS[input.plan]}会员 · ${input.period === 'yearly' ? '年付' : '月付'}`,
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
      planLabel: PLAN_LABELS[input.plan] ?? input.plan,
      period: input.period,
      channel: provider.channel,
      amountCents,
      status: row.status,
      mock: provider.channel === 'mock',
      qrDataUrl,
      payUrl: channelOrder.codeUrl,
      expireAt,
      createdAt: row.createdAt,
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
      planLabel: PLAN_LABELS[row.plan as PlanTier] ?? row.plan,
      period: row.period as BillingPeriod,
      channel: row.channel,
      mock: row.channel === 'mock',
      amountCents: row.amountCents,
      status: row.status,
      qrDataUrl: (row.meta as Record<string, string>).qrDataUrl ?? null,
      paidAt: row.paidAt,
      expireAt: row.expireAt,
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
    // 401=验签失败(非微信请求,重试无意义);5xx=签名合法但内容不可读(如解密失败),让渠道重试自愈
    if (!result.ok) {
      return { status: result.httpStatus ?? HttpStatus.UNAUTHORIZED, body: result.ackBody };
    }
    if (result.paid && result.outTradeNo) {
      // 金额不一致属永久性差异:ack 成功止住渠道重试风暴,订单保留 created 供人工对账
      try {
        await this.settleByOutTradeNo(result.outTradeNo, 'wechat', result.channelTradeId, result.amountCents);
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === HttpStatus.CONFLICT) {
          return { status: HttpStatus.OK, body: result.ackBody };
        }
        throw err; // 瞬时错误(如 DB 抖动)回 fail,让渠道重试
      }
    }
    return { status: HttpStatus.OK, body: result.ackBody };
  }

  async handleAlipayNotify(body: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const result = await this.alipay.verifyNotify({}, '', body);
    if (!result.ok) return { status: HttpStatus.UNAUTHORIZED, body: 'fail' };
    if (result.paid && result.outTradeNo) {
      try {
        await this.settleByOutTradeNo(result.outTradeNo, 'alipay', result.channelTradeId, result.amountCents);
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === HttpStatus.CONFLICT) {
          return { status: HttpStatus.OK, body: result.ackBody };
        }
        throw err;
      }
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
   * 认领与订阅刷新同事务:中途失败整体回滚,渠道重试可重新认领取发货——
   * 否则"已 paid 但订阅未刷新"将成为永久态(付费不生效且无法自愈)。
   */
  private async settle(order: typeof orders.$inferSelect, channelTradeId: string | null, amountCents: number | null) {
    if (amountCents !== null && amountCents !== order.amountCents) {
      console.error(`[billing] amount mismatch: order ${order.outTradeNo} expect ${order.amountCents} got ${amountCents}`);
      throw new HttpException('回调金额与订单不一致', HttpStatus.CONFLICT);
    }

    const plan = order.plan as PlanTier;
    const now = new Date();
    const period = order.period as BillingPeriod;

    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(orders)
        .set({ status: 'paid', channelTradeId, paidAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, 'created')))
        .returning({ id: orders.id });
      if (claimed.length === 0) return; // 已被并发/上次回调认领

      // 会员为账号级:名下全部活跃品牌订阅统一刷新(配额执行点在 subscriptions 行)。
      // 档位只升不降:为另一品牌买低档不得把已购高档订阅降级(已付费权益缩水),
      // 与账号级 resolveMembership"取最高档"口径一致;periodEnd 仍按本次购买周期顺延
      const subs = await tx.select().from(subscriptions).where(eq(subscriptions.accountId, order.accountId));
      for (const s of subs) {
        if (s.status !== 'active') continue;
        const downgrade = (PLAN_RANK[s.plan as PlanTier] ?? 0) > (PLAN_RANK[plan] ?? 0);
        const effective = downgrade ? (s.plan as PlanTier) : plan;
        const effLimits = PLAN_LIMITS[effective] ?? PLAN_LIMITS.free;
        await tx
          .update(subscriptions)
          .set({
            plan: effective,
            questionQuota: { ranking: effLimits.rankingQuota, reputation: effLimits.reputationQuota },
            engineQuota: { web: effLimits.webEngines, app: effLimits.appEngines },
            periodEnd: nextPeriodEnd(s.periodEnd, period, now),
          })
          .where(eq(subscriptions.id, s.id));
        // 采集计划引擎同步刷新:否则建号时的旧档位引擎列表(如 3 引擎)在升级后仍然生效,
        // 轮次任务数 = 题数 × 旧引擎数,套餐扩容不生效(实测 12 ≠ 20 事故)
        await tx
          .update(collectionPlans)
          .set({ engines: WEB_ENGINES.slice(0, effLimits.webEngines) })
          .where(eq(collectionPlans.brandId, s.brandId));
      }
    });
  }
}
