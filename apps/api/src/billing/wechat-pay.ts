import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ChannelOrderInput,
  ChannelOrderResult,
  NotifyVerifyResult,
  PaymentProvider,
} from './payment-provider';
import { toRfc3339Beijing } from './timeformat';

/**
 * 微信支付 v3 Native 下单(docs/02 §7):
 * - 下单:SHA256-RSA2048 请求签名(Authorization: WECHATPAY2-SHA256-RSA2048)
 * - 回调:平台证书验签 + APIv3 key AES-256-GCM 解密 resource
 * 密钥经环境注入,未配置时 configured=false(由 BillingService 决定降级或拒绝)。
 */
export class WechatPayProvider implements PaymentProvider {
  readonly channel = 'wechat' as const;
  readonly configured: boolean;

  private readonly appId: string;
  private readonly mchId: string;
  private readonly serialNo: string;
  private readonly apiV3Key: string;
  private readonly privateKey: KeyObject | null;
  private readonly platformPublicKey: KeyObject | null;
  private readonly gateway = 'https://api.mch.weixin.qq.com';

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.WECHAT_PAY_APPID ?? '';
    this.mchId = env.WECHAT_PAY_MCHID ?? '';
    this.serialNo = env.WECHAT_PAY_SERIAL_NO ?? '';
    this.apiV3Key = env.WECHAT_PAY_APIV3_KEY ?? '';
    const keyPath = env.WECHAT_PAY_PRIVATE_KEY_PATH ?? '';
    this.privateKey = keyPath ? readKey(keyPath) : null;
    const platformCertPath = env.WECHAT_PAY_PLATFORM_CERT_PATH ?? '';
    this.platformPublicKey = platformCertPath ? readKey(platformCertPath) : null;
    this.configured = Boolean(
      this.appId && this.mchId && this.serialNo && this.apiV3Key && this.privateKey && this.platformPublicKey,
    );
  }

  async createOrder(input: ChannelOrderInput): Promise<ChannelOrderResult> {
    if (!this.configured || !this.privateKey) throw new Error('wechat pay not configured');
    const body = JSON.stringify({
      appid: this.appId,
      mchid: this.mchId,
      description: input.subject.slice(0, 127),
      out_trade_no: input.outTradeNo,
      time_expire: toRfc3339Beijing(input.expireAt),
      notify_url: input.notifyUrl,
      amount: { total: input.amountCents, currency: 'CNY' },
    });
    const path = '/v3/pay/transactions/native';
    const res = await fetch(`${this.gateway}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: this.authHeader('POST', path, body),
      },
      body,
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !raw.code_url) {
      throw new Error(`wechat native order failed: ${res.status} ${JSON.stringify(raw)}`);
    }
    return { codeUrl: String(raw.code_url), channelTradeId: null, raw };
  }

  async verifyNotify(
    headers: Record<string, string>,
    rawBody: string,
    _body: Record<string, unknown>,
  ): Promise<NotifyVerifyResult> {
    const ack = JSON.stringify({ code: 'SUCCESS', message: '成功' });
    if (!this.platformPublicKey || !this.apiV3Key) {
      return { ok: false, outTradeNo: null, channelTradeId: null, amountCents: null, paid: false, raw: {}, ackBody: ack };
    }
    const timestamp = headers['wechatpay-timestamp'] ?? '';
    const nonce = headers['wechatpay-nonce'] ?? '';
    const signature = headers['wechatpay-signature'] ?? '';
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const signOk =
      signature.length > 0 &&
      createVerify('RSA-SHA256').update(message).verify(this.platformPublicKey, signature, 'base64');
    if (!signOk) {
      return { ok: false, outTradeNo: null, channelTradeId: null, amountCents: null, paid: false, raw: {}, ackBody: ack };
    }

    const parsed = JSON.parse(rawBody) as {
      resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
    };
    let event: Record<string, unknown> = {};
    try {
      event = JSON.parse(this.decryptResource(parsed.resource ?? {}).toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      // 签名合法但解密失败(典型:APIv3 key 配错/轮换)必须回 5xx 让微信重试,
      // 否则 ack 成功后渠道不再通知,支付结果静默丢失且无自愈路径
      console.error(`[wechat-pay] notify decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        outTradeNo: null,
        channelTradeId: null,
        amountCents: null,
        paid: false,
        raw: parsed,
        ackBody: JSON.stringify({ code: 'FAIL', message: '解密失败' }),
        httpStatus: 500,
      };
    }
    const amount = (event.amount ?? {}) as { total?: number; payer_total?: number };
    return {
      ok: true,
      outTradeNo: (event.out_trade_no as string) ?? null,
      channelTradeId: (event.transaction_id as string) ?? null,
      // 订单金额口径 = 下单金额 total;payer_total(用户券后实付)小于 total 属正常,
      // 不能用核对,否则用券订单永远金额不一致、付款后不发货(raw 里保留 payer_total 供对账)
      amountCents: amount.total ?? amount.payer_total ?? null,
      paid: event.trade_state === 'SUCCESS',
      raw: event,
      ackBody: ack,
    };
  }

  /** APIv3 AES-256-GCM:密文末 16 字节为 tag(docs/07 §9 对账语义,密钥不落盘日志)。 */
  private decryptResource(resource: { ciphertext?: string; nonce?: string; associated_data?: string }): Buffer {
    if (!resource.ciphertext || !resource.nonce) throw new Error('wechat resource incomplete');
    const buf = Buffer.from(resource.ciphertext, 'base64');
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'));
    decipher.setAuthTag(tag);
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  private authHeader(method: string, path: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(this.privateKey!, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.serialNo}"`;
  }
}

function readKey(path: string): KeyObject | null {
  try {
    const content = readFileSync(path, 'utf8');
    if (content.includes('PRIVATE KEY')) return createPrivateKey(content);
    return createPublicKey(content);
  } catch {
    return null;
  }
}
