import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 登录态静态加密(docs/04 §3.1):账号池的 cookies/storageState 是产品核心资产,
 * 明文 jsonb 落库时拖库/备份泄漏 = 全部池账号被接管,故写入前信封加密(AES-256-GCM)。
 * 历史明文行透明兼容:open() 见非密封形态原样返回,下一次 save() 自动升级为密文。
 * 密钥只经环境变量 CREDENTIAL_ENC_KEY 注入(hex 64 位 = 32 字节,或 base64 44 位);
 * 生产未配置时读侧继续兼容明文、写侧抛错(fail-safe:宁可登录态无法回写,不可明文新增)。
 */
export const CREDENTIAL_ENC_KEY_ENV = 'CREDENTIAL_ENC_KEY';

export interface SealedSecret {
  __geo_secret: 1;
  alg: 'aes-256-gcm';
  iv: string;
  ct: string;
}

const marker: keyof SealedSecret = '__geo_secret';

export function isSealedSecret(v: unknown): v is SealedSecret {
  return (
    typeof v === 'object' && v !== null && (v as Record<string, unknown>)[marker] === 1
  );
}

function sealValue(value: unknown, key: Buffer): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // GCM 认证 tag 拼在密文尾部,解密时拆出校验——防篡改
  const ct = Buffer.concat([cipher.update(JSON.stringify(value ?? null), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { __geo_secret: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function openValue<T>(sealed: SealedSecret, key: Buffer): T {
  const iv = Buffer.from(sealed.iv, 'base64');
  const raw = Buffer.from(sealed.ct, 'base64');
  if (raw.length < 16) throw new Error('sealed secret ciphertext too short');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}

export function parseCredentialKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  return null;
}

export class SecretBox {
  private warned = false;

  private constructor(
    /** null = 未配置密钥(开发透传/生产只读兼容) */
    readonly key: Buffer | null,
    private readonly strictWrites: boolean,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    const key = parseCredentialKey(env[CREDENTIAL_ENC_KEY_ENV]);
    if (key) return new SecretBox(key, false);
    // 生产缺密钥:读侧必须兼容(否则升级即断采集),写侧拒绝新增明文
    return new SecretBox(null, env.NODE_ENV === 'production');
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** 入库前密封。null(未配置密钥)透传返回原值——历史行为;生产 strict 模式抛错。 */
  seal<T>(value: T): T | SealedSecret {
    if (!this.key) {
      if (this.strictWrites) {
        throw new Error(
          `${CREDENTIAL_ENC_KEY_ENV} 未配置:生产环境拒绝明文写入登录态(生成: openssl rand -hex 32)`,
        );
      }
      if (!this.warned) {
        this.warned = true;
        console.warn(`[secret-box] 未配置 ${CREDENTIAL_ENC_KEY_ENV},登录态将以明文存储(仅限非生产)`);
      }
      return value;
    }
    return value === null || value === undefined ? value : sealValue(value, this.key);
  }

  /** 出库后解封。非密封形态(历史明文/mock 档案)原样返回;解密失败抛错让调用方感知密钥错配。 */
  open<T>(stored: T | SealedSecret | null | undefined): T | null {
    if (stored === null || stored === undefined) return null;
    if (!isSealedSecret(stored)) return stored as T;
    if (!this.key) {
      throw new Error(
        `数据库中存在加密登录态但 ${CREDENTIAL_ENC_KEY_ENV} 未配置——密钥丢失/错配,该档案不可用`,
      );
    }
    return openValue<T>(stored, this.key);
  }
}
