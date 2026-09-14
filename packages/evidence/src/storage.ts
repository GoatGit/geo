import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface EvidenceStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** 短时效签名 URL(STS 语义;local 实现返回 file:// 仅供 dev) */
  signedUrl(key: string, ttlSec: number): Promise<string>;
}

function assertEvidenceKey(key: string): string {
  const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!clean.startsWith('evidence/')) {
    throw new Error(`evidence key must start with evidence/: ${key}`);
  }
  return clean;
}

export interface S3EvidenceConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** S3 兼容存储(本地 MinIO / 生产 OSS,docs/03 §2):WORM/生命周期由存储侧策略执行。 */
export class S3EvidenceStorage implements EvidenceStorage {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3EvidenceConfig) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: assertEvidenceKey(key),
        Body: body,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async signedUrl(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: assertEvidenceKey(key) }),
      { expiresIn: ttlSec },
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: assertEvidenceKey(key) }),
    );
    if (!res.Body) throw new Error(`evidence object empty: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }
}

/** dev/测试实现:本地文件系统。 */
export class LocalEvidenceStorage implements EvidenceStorage {
  constructor(private readonly rootDir: string) {}

  async put(key: string, body: Buffer): Promise<void> {
    const clean = assertEvidenceKey(key);
    const abs = resolve(join(this.rootDir, clean));
    if (!abs.startsWith(resolve(this.rootDir))) {
      throw new Error(`path traversal blocked: ${key}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }

  async signedUrl(key: string): Promise<string> {
    const clean = assertEvidenceKey(key);
    return `file://${join(this.rootDir, clean)}`;
  }

  async get(key: string): Promise<Buffer> {
    const clean = assertEvidenceKey(key);
    return readFile(join(this.rootDir, clean));
  }
}

export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceStorage {
  if ((env.EVIDENCE_STORAGE ?? 'local') === 's3') {
    return new S3EvidenceStorage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'cn-shanghai',
      bucket: env.S3_BUCKET ?? 'geo-evidence',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return new LocalEvidenceStorage(env.EVIDENCE_LOCAL_DIR ?? './infra/local-data/evidence');
}
