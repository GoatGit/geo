import { HttpException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
    const existing = (
      await this.db.select().from(smsCodes).where(eq(smsCodes.phone, phone)).limit(1)
    )[0];
    if (existing?.createdAt && Date.now() - existing.createdAt.getTime() < 60_000) {
      const wait = Math.ceil((60_000 - (Date.now() - existing.createdAt.getTime())) / 1000);
      throw new HttpException(`发送过于频繁,请 ${wait}s 后重试`, 429);
    }
    const code = String(randomInt(100000, 1000000));
    const env = loadEnv();
    await this.provider.send(phone, code);
    const codeHash = sha256(code + phone);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await this.db
      .insert(smsCodes)
      .values({ phone, codeHash, expiresAt })
      .onConflictDoUpdate({
        target: smsCodes.phone,
        set: { codeHash, expiresAt, attempts: 0, createdAt: new Date() },
      });
    return env.nodeEnv === 'production' ? {} : { devCode: code };
  }

  async verifyLoginCode(phone: string, code: string): Promise<boolean> {
    const row = (
      await this.db.select().from(smsCodes).where(eq(smsCodes.phone, phone)).limit(1)
    )[0];
    if (!row) return false;
    if (row.expiresAt.getTime() < Date.now()) return false;
    if (row.attempts >= 5) return false;
    if (row.codeHash !== sha256(code + phone)) {
      await this.db
        .update(smsCodes)
        .set({ attempts: row.attempts + 1 })
        .where(eq(smsCodes.phone, phone));
      return false;
    }
    await this.db.delete(smsCodes).where(eq(smsCodes.phone, phone));
    return true;
  }

  async upsertAccountByPhone(phone: string): Promise<{ id: number; phone: string; role: string }> {
    const env = loadEnv();
    const role = env.adminPhones.includes(phone) ? 'admin' : 'user';
    const existing = (await this.db.select().from(accounts).where(eq(accounts.phone, phone)).limit(1))[0];
    if (existing) {
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
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
