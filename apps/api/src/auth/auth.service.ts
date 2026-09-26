import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { smsCodes, accounts } from '@geo/db';
import { loadEnv } from '../config/env';
import { DB } from '../common/infra.module';

export interface SmsProvider {
  send(phone: string, code: string): Promise<void>;
}

/** dev 实现:验证码打印到日志(调用方在非生产环境可直接返回)。 */
export class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, code: string): Promise<void> {
    // dev 通道:验证码打印到 stdout(前端 devCode 直显);生产替换为阿里云短信
    console.log(`[sms:console] ${phone} -> ${code}`);
  }
}

/** 阿里云短信真实实现(Dysmsapi POP RPC + HMAC-SHA1 签名;签名/模板需报备通过)。 */
export class AliyunSmsProvider implements SmsProvider {
  private readonly endpoint = 'dysmsapi.aliyuncs.com';

  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly signName: string,
    private readonly templateCode: string,
  ) {}

  async send(phone: string, code: string): Promise<void> {
    const params: Record<string, string> = {
      Action: 'SendSms',
      Version: '2017-05-25',
      RegionId: 'cn-hangzhou',
      PhoneNumbers: phone,
      SignName: this.signName,
      TemplateCode: this.templateCode,
      TemplateParam: JSON.stringify({ code }),
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };

    const pct = (s: string) =>
      encodeURIComponent(s).replace(/[+*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const canon = Object.keys(params)
      .sort()
      .map((k) => `${pct(k)}=${pct(params[k])}`)
      .join('&');
    const toSign = `GET&${pct('/')}&${pct(canon)}`;
    const signature = createHmac('sha1', `${this.accessKeySecret}&`)
      .update(toSign)
      .digest('base64');

    const url = `https://${this.endpoint}/?${canon}&Signature=${pct(signature)}`;
    const res = await fetch(url, { method: 'GET' });
    const body = (await res.json()) as { Code?: string; Message?: string };
    if (body.Code !== 'OK') {
      throw new Error(`aliyun sms send failed: ${body.Code ?? 'UNKNOWN'} ${body.Message ?? ''}`);
    }
  }
}

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  private get provider(): SmsProvider {
    const env = loadEnv();
    return env.smsProvider === 'aliyun'
      ? new AliyunSmsProvider(
          process.env.ALIYUN_SMS_ACCESS_KEY_ID ?? '',
          process.env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '',
          process.env.ALIYUN_SMS_SIGN_NAME ?? '',
          process.env.ALIYUN_SMS_TEMPLATE_CODE ?? '',
        )
      : new ConsoleSmsProvider();
  }

  /** 显式点击后才发送(docs/research 03 A8 对策:不做自动发送);同号 60s 重发冷却,防刷短信成本。 */
  async sendLoginCode(phone: string): Promise<{ devCode?: string }> {
    const env = loadEnv();
    const now = new Date();
    const code = String(randomInt(100000, 1000000));
    const codeHash = sha256(code + phone);
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    // 冷却原子认领:upsert 带 where 谓词(无记录,或旧记录已过 60s),并发请求只有一个成功,
    // 消除"先读后写"窗口导致的短信成本被刷;发送失败则释放认领,用户可立即重试
    const claimed = await this.db
      .insert(smsCodes)
      .values({ phone, codeHash, expiresAt, createdAt: now })
      .onConflictDoUpdate({
        target: smsCodes.phone,
        set: { codeHash, expiresAt, attempts: 0, createdAt: now },
        where: lt(smsCodes.createdAt, new Date(now.getTime() - 60_000)),
      })
      .returning({ createdAt: smsCodes.createdAt });
    if (claimed.length === 0) {
      const existing = (
        await this.db.select({ createdAt: smsCodes.createdAt }).from(smsCodes).where(eq(smsCodes.phone, phone)).limit(1)
      )[0];
      const waited = existing?.createdAt ? Math.ceil((existing.createdAt.getTime() + 60_000 - now.getTime()) / 1000) : 60;
      throw new HttpException(`发送过于频繁,请 ${Math.max(waited, 1)}s 后重试`, 429);
    }
    try {
      await this.provider.send(phone, code);
    } catch (err) {
      await this.db.delete(smsCodes).where(eq(smsCodes.phone, phone));
      throw err;
    }
    return env.nodeEnv === 'production' ? {} : { devCode: code };
  }

  async verifyLoginCode(phone: string, code: string): Promise<boolean> {
    const row = (
      await this.db.select().from(smsCodes).where(eq(smsCodes.phone, phone)).limit(1)
    )[0];
    if (!row) return false;
    if (row.expiresAt.getTime() < Date.now()) return false;
    if (row.attempts >= 5) return false;
    if (row.codeHash === sha256(code + phone)) {
      // 核销即消费:DELETE 影响行数即凭证,防并发同码复用(select→delete 窗口内第二个请求仍通过)
      const consumed = await this.db
        .delete(smsCodes)
        .where(eq(smsCodes.phone, phone))
        .returning({ phone: smsCodes.phone });
      return consumed.length > 0;
    }
    // 错误码:原子条件自增(带 attempts<5 谓词),并发猜测各自累加而非互相覆盖旧值,
    // 5 次上限才能真正生效(读-改-写竞态曾使上限可被并发击穿,6 位码可在有效期内持续枚举)
    const bumped = await this.db
      .update(smsCodes)
      .set({ attempts: sql`${smsCodes.attempts} + 1` })
      .where(and(eq(smsCodes.phone, phone), lt(smsCodes.attempts, 5)))
      .returning({ attempts: smsCodes.attempts });
    if (bumped[0] && bumped[0].attempts >= 5) {
      console.warn(`[auth] sms code locked after 5 attempts: phone=***${phone.slice(-4)}`);
    }
    return false;
  }

  async upsertAccountByPhone(phone: string): Promise<{ id: number; phone: string | null; role: string }> {
    const env = loadEnv();
    const role = env.adminPhones.includes(phone) ? 'admin' : 'user';
    const existing = (await this.db.select().from(accounts).where(eq(accounts.phone, phone)).limit(1))[0];
    if (existing) {
      // 封禁/停用账号拒绝登录(schema 有 status 字段,无消费方则封禁是假能力)
      if (existing.status && existing.status !== 'active') {
        throw new HttpException('账号已被停用,请联系客服', HttpStatus.FORBIDDEN);
      }
      // 名单新增时给已有账号补授角色;移出名单不自动降级(降级需显式操作,避免误伤在用管理员)
      if (existing.role !== role && role === 'admin') {
        await this.db.update(accounts).set({ role }).where(eq(accounts.id, existing.id));
      }
      return { id: existing.id, phone: existing.phone, role: role === 'admin' ? 'admin' : existing.role };
    }
    const inserted = (
      await this.db.insert(accounts).values({ phone, role }).returning({ id: accounts.id, phone: accounts.phone, role: accounts.role })
    )[0]!;
    return inserted;
  }

  /**
   * 微信扫码登录(docs/01 登录方式扩展):
   * ① 生成扫码登录跳转 URL(open.weixin.qq.com/connect/qrconnect,scope=snsapi_login)
   * ② code 换 access_token + openid → 按 wechat_openid 找/建账号 → 签发本站 JWT。
   * AppID/Secret 来自开放平台「网站应用」(授权回调域须含本站域名)。
   */
  wechatQrUrl(redirectUri: string, state: string): string {
    const env = loadEnv();
    const q = new URLSearchParams({
      appid: env.wechatOpenAppId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state,
    });
    return `https://open.weixin.qq.com/connect/qrconnect?${q.toString()}#wechat_redirect`;
  }

  async wechatExchange(
    code: string,
  ): Promise<{ id: number; phone: string | null; role: string; wechatNick?: string }> {
    const env = loadEnv();
    const q = new URLSearchParams({
      appid: env.wechatOpenAppId,
      secret: env.wechatOpenAppSecret,
      code,
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${q.toString()}`);
    const tokenData = (await tokenRes.json()) as {
      access_token?: string; openid?: string; unionid?: string; errcode?: number; errmsg?: string;
    };
    if (!tokenData.openid) {
      throw new HttpException(`微信授权失败:${tokenData.errmsg ?? 'unknown'}`, HttpStatus.UNAUTHORIZED);
    }
    // 拉取昵称/头像(失败不影响登录,仅展示信息)
    let wechatNick: string | undefined;
    try {
      const uiRes = await fetch(
        `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenData.access_token}&openid=${tokenData.openid}`,
      );
      const ui = (await uiRes.json()) as { nickname?: string };
      if (ui.nickname) wechatNick = ui.nickname;
    } catch { /* 用户信息可选 */ }

    const existing = (
      await this.db.select().from(accounts).where(eq(accounts.wechatOpenid, tokenData.openid)).limit(1)
    )[0];
    if (existing) {
      if (existing.status && existing.status !== 'active') {
        throw new HttpException('账号已被停用,请联系客服', HttpStatus.FORBIDDEN);
      }
      return { id: existing.id, phone: existing.phone, role: existing.role, wechatNick };
    }
    const inserted = (
      await this.db
        .insert(accounts)
        .values({ phone: null, wechatOpenid: tokenData.openid, wechatUnionid: tokenData.unionid ?? null })
        .returning({ id: accounts.id, phone: accounts.phone, role: accounts.role })
    )[0]!;
    return { id: inserted.id, phone: inserted.phone, role: inserted.role, wechatNick };
  }


  /** 微信 OAuth 的防 CSRF state:HMAC(jwtRefreshSecret, ts),10 分钟有效,免存储。 */
  wechatState(): string {
    const env = loadEnv();
    const ts = Date.now().toString();
    const sig = createHmac('sha256', env.jwtRefreshSecret).update(ts).digest('hex').slice(0, 32);
    return `${ts}.${sig}`;
  }

  validateWechatState(state: string): boolean {
    const [ts, sig] = state.split('.');
    if (!ts || !sig) return false;
    const expect = createHmac('sha256', loadEnv().jwtRefreshSecret).update(ts).digest('hex').slice(0, 32);
    return sig === expect && Date.now() - Number(ts) < 600_000;
  }

  /** 刷新令牌时从库重读角色:被移出管理名单的账号不再靠旧 JWT 声明续权。 */
  async roleOf(accountId: number): Promise<string> {
    const row = (
      await this.db.select({ role: accounts.role, status: accounts.status }).from(accounts).where(eq(accounts.id, accountId)).limit(1)
    )[0];
    if (!row || (row.status && row.status !== 'active')) throw new HttpException('账号不可用', HttpStatus.FORBIDDEN);
    return row.role;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
