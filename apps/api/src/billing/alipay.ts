import { createPrivateKey, createPublicKey, createSign, createVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ChannelOrderInput,
  ChannelOrderResult,
  NotifyVerifyResult,
  PaymentProvider,
} from './payment-provider';
import { toAlipayTimestamp } from './timeformat';

/**
 * 支付宝扫码支付(alipay.trade.precreate,docs/02 §7):
 * - 请求:RSA2(SHA256withRSA)签名,参数 ASCII 升序拼接后私钥签名,form 提交网关
 * - 回调:剔除 sign/sign_type 后同规则拼接,用支付宝公钥验签;trade_status=TRADE_SUCCESS 视为支付成功
 */
export class AlipayProvider implements PaymentProvider {
  readonly channel = 'alipay' as const;
  readonly configured: boolean;

  private readonly appId: string;
  private readonly gateway: string;
  private readonly appPrivateKey: KeyObject | null;
  private readonly alipayPublicKey: KeyObject | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.appId = env.ALIPAY_APP_ID ?? '';
    this.gateway = env.ALIPAY_GATEWAY ?? 'https://openapi.alipay.com/gateway.do';
    this.appPrivateKey = readKeyPem(env.ALIPAY_PRIVATE_KEY_PATH ?? '', true);
    this.alipayPublicKey = readKeyPem(env.ALIPAY_PUBLIC_KEY_PATH ?? '', false);
    this.configured = Boolean(this.appId && this.appPrivateKey && this.alipayPublicKey);
  }

  async createOrder(input: ChannelOrderInput): Promise<ChannelOrderResult> {
    if (!this.configured || !this.appPrivateKey) throw new Error('alipay not configured');
    const bizContent = {
      out_trade_no: input.outTradeNo,
      total_amount: (input.amountCents / 100).toFixed(2),
      subject: input.subject.slice(0, 128),
      timeout_express: '2h',
    };
    const params = this.systemParams({
      method: 'alipay.trade.precreate',
      biz_content: JSON.stringify(bizContent),
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
    });
    const signed = this.signParams(params);
    const res = await fetch(this.gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed).toString(),
    });
    const text = await res.text();
    const json = JSON.parse(text) as {
      alipay_trade_precreate_response?: { code?: string; msg?: string; qr_code?: string; out_trade_no?: string };
      sign?: string;
    };
    const resp = json.alipay_trade_precreate_response ?? {};
    // 响应验签(有支付宝公钥时强制):原文为 response 节点的原始 JSON 串
    if (this.alipayPublicKey && json.sign && !this.verifyRawSnippet(text, 'alipay_trade_precreate_response', json.sign)) {
      throw new Error('alipay precreate response signature mismatch');
    }
    if (resp.code !== '10000' || !resp.qr_code) {
      throw new Error(`alipay precreate failed: ${resp.code} ${resp.msg ?? ''}`);
    }
    return { codeUrl: resp.qr_code, channelTradeId: null, raw: { code: resp.code, outTradeNo: resp.out_trade_no } };
  }

  async verifyNotify(
    headers: Record<string, string>,
    _rawBody: string,
    body: Record<string, unknown>,
  ): Promise<NotifyVerifyResult> {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) params[k] = String(v);
    const sign = params.sign ?? '';
    const signOk = sign.length > 0 && this.alipayPublicKey !== null && this.verifyParams(params, sign);
    const tradeStatus = params.trade_status ?? '';
    const amountYuan = Number(params.total_amount ?? 0);
    return {
      ok: signOk,
      outTradeNo: params.out_trade_no ?? null,
      channelTradeId: params.trade_no ?? null,
      amountCents: Number.isFinite(amountYuan) ? Math.round(amountYuan * 100) : null,
      paid: signOk && (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED'),
      raw: params,
      ackBody: signOk ? 'success' : 'fail',
    };
  }

  /** 系统参数 + 公共参数(docs/07:密钥仅经环境注入)。 */
  private systemParams(extra: Record<string, string>): Record<string, string> {
    return {
      app_id: this.appId,
      method: extra.method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: toAlipayTimestamp(),
      version: '1.0',
      ...extra,
    };
  }

  /** RSA2 签名:剔除 sign 后按 key ASCII 升序 k=v& 拼接,私钥 SHA256withRSA。 */
  private signParams(params: Record<string, string>): Record<string, string> {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const sign = createSign('RSA-SHA256').update(content, 'utf8').sign(this.appPrivateKey!, 'base64');
    return { ...params, sign };
  }

  private verifyParams(params: Record<string, string>, sign: string): boolean {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    try {
      return createVerify('RSA-SHA256').update(content, 'utf8').verify(this.alipayPublicKey!, sign, 'base64');
    } catch {
      return false;
    }
  }

  /** 响应节点验签:从原始文本截取 "{节点名": 后的完整 JSON 片段(支付宝验签规则)。 */
  private verifyRawSnippet(text: string, node: string, sign: string): boolean {
    const marker = `"${node}":`;
    const start = text.indexOf(marker);
    if (start < 0) return false;
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) return false;
    try {
      return createVerify('RSA-SHA256').update(text.slice(start + marker.length, end), 'utf8').verify(this.alipayPublicKey!, sign, 'base64');
    } catch {
      return false;
    }
  }
}

function readKeyPem(path: string, isPrivate: boolean): KeyObject | null {
  try {
    const content = readFileSync(path, 'utf8');
    return isPrivate ? createPrivateKey(content) : createPublicKey(content);
  } catch {
    return null;
  }
}
