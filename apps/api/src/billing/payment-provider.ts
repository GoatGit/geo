import type { PayChannel } from '@geo/shared';

/**
 * 支付渠道抽象(docs/02 §7 商业化):下单 + 回调验签。
 * 渠道实现只做"收单语义",订单状态流转与订阅激活在 BillingService(对账以 orders 表为准)。
 */
export interface ChannelOrderInput {
  outTradeNo: string;
  /** 金额:分(微信原生单位;支付宝侧换算为元) */
  amountCents: number;
  subject: string;
  /** 支付结果异步通知地址(需公网可达;mock/dev 可空) */
  notifyUrl?: string;
  /** 支付完成后的浏览器跳转地址(支付宝电脑网站支付用) */
  returnUrl?: string;
  /** 订单过期时间(ISO) */
  expireAt: string;
}

export interface ChannelOrderResult {
  /** 收银台/二维码内容(微信 Native 为 code_url;支付宝预创建为 qr_code) */
  codeUrl: string | null;
  channelTradeId: string | null;
  /** 渠道原始响应(存 orders.meta 便于对账排障,不落敏感密钥) */
  raw: Record<string, unknown>;
}

export interface NotifyVerifyResult {
  ok: boolean;
  outTradeNo: string | null;
  channelTradeId: string | null;
  /** 渠道回调声称的实付金额(分);与订单金额核对防篡改 */
  amountCents: number | null;
  /** true 表示渠道确认支付成功;false 但签名合法时应返回 success 静默(如重复通知) */
  paid: boolean;
  raw: Record<string, unknown>;
  /** 验签合法时应答渠道的响应体(微信 {} / 支付宝 'success') */
  ackBody: string;
  /** 覆盖回调应答的 HTTP 状态:解密失败等"签名合法但内容不可读"场景应 5xx 让渠道重试(缺省按 ok 映射 200/401) */
  httpStatus?: number;
}

export interface PaymentProvider {
  readonly channel: PayChannel;
  readonly configured: boolean;
  createOrder(input: ChannelOrderInput): Promise<ChannelOrderResult>;
  verifyNotify(headers: Record<string, string>, rawBody: string, body: Record<string, unknown>): Promise<NotifyVerifyResult>;
}
