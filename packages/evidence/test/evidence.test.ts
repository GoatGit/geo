import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildEvidencePack, sha256, verifyEvidencePack } from '../src/pack';
import { LocalEvidenceStorage } from '../src/storage';

const input = {
  runId: 'run-1',
  brandId: 7,
  engine: 'doubao',
  surface: 'web',
  adapterVersion: 'mock-1',
  question: '20万预算纯电轿车推荐',
  accountFingerprint: 'fp_abc123',
  egressIp: '10.0.0.1',
  status: 'ok_with_answer' as const,
  answerText: '推荐:\n\n1. 小米 SU7\n2. 比亚迪海豹',
  rawHtml: '<html>raw</html>',
  citations: [{ url: 'https://www.dongchedi.com/article/9001', title: '横评' }],
  timing: { queuedAt: 't0', firstTokenAt: 't1', completedAt: 't2' },
  frames: [{ index: 0, capturedAt: 't1', dataBase64: Buffer.from('frame0').toString('base64') }],
};

describe('buildEvidencePack(docs/04 §4)', () => {
  it('包含 answer/raw/meta/frames/integrity 五类文件', () => {
    const pack = buildEvidencePack(input);
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain('evidence/run-1/answer.json');
    expect(paths).toContain('evidence/run-1/raw.html');
    expect(paths).toContain('evidence/run-1/meta.json');
    expect(paths).toContain('evidence/run-1/recording/frames/000000.jpg');
    expect(paths).toContain('evidence/run-1/integrity.sha256');
  });

  it('meta 不含问题原文,只有哈希与指纹哈希(脱敏)', () => {
    const pack = buildEvidencePack(input);
    const meta = JSON.parse(
      pack.files.find((f) => f.path.endsWith('meta.json'))!.body.toString('utf8'),
    );
    expect(meta.questionHash).toBe(sha256(input.question));
    expect(meta.accountFingerprint).toBe('fp_abc123');
    expect(JSON.stringify(meta)).not.toContain('20万预算');
  });

  it('integrity.sha256 覆盖其余全部文件,manifestHash 可复算', () => {
    const pack = buildEvidencePack(input);
    const manifest = pack.files.find((f) => f.path.endsWith('integrity.sha256'))!.body.toString();
    const lines = manifest.trim().split('\n');
    expect(lines).toHaveLength(pack.files.length - 1);
    for (const line of lines) {
      const [hash, path] = line.split(/ {2}/);
      const file = pack.files.find((f) => f.path.endsWith(path!))!;
      expect(createHash('sha256').update(file.body).digest('hex')).toBe(hash);
    }
    expect(pack.manifestHash).toBe(sha256(pack.files.find((f) => f.path.endsWith('integrity.sha256'))!.body));
  });

  it('answer.json 携带问题原文、回答正文与引用(docs/04 §4)', () => {
    const pack = buildEvidencePack(input);
    const answer = JSON.parse(
      pack.files.find((f) => f.path.endsWith('answer.json'))!.body.toString('utf8'),
    );
    expect(answer.question).toBe(input.question);
    expect(answer.citations).toHaveLength(1);
    expect(answer.answerText).toContain('小米 SU7');
  });
});

describe('LocalEvidenceStorage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geo-evidence-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put + signedUrl 往返;路径遍历与命名空间被拦截', async () => {
    const storage = new LocalEvidenceStorage(dir);
    const pack = buildEvidencePack(input);
    for (const f of pack.files) await storage.put(f.path, f.body);

    const body = await readFile(join(dir, 'evidence/run-1/meta.json'), 'utf8');
    expect(body).toContain('questionHash');

    const url = await storage.signedUrl('evidence/run-1/meta.json', 60);
    expect(url).toContain('evidence/run-1/meta.json');

    await expect(storage.put('not-evidence/x.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.put('evidence/../../etc/passwd', Buffer.from('x'))).rejects.toThrow();
  });

  it('路径遍历挡住反斜杠形态与兄弟目录前缀(曾可绕过 startsWith 前缀检查)', async () => {
    const storage = new LocalEvidenceStorage(dir);
    // Windows 分隔符形态:posix 上反斜杠是普通字符,join/resolve 在 win32 会解释为目录跳转
    await expect(storage.put('evidence\\..\\..\\evil.txt', Buffer.from('x'))).rejects.toThrow();
    // 兄弟目录:/data/evidence-evil 能通过 /data/evidence 的 startsWith 前缀检查,relative() 判定挡住
    await expect(storage.put('evidence/../evidence-evil/x.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.get('evidence/..\\secret')).rejects.toThrow();
  });
});

describe('verifyEvidencePack(读取侧防篡改闭环)', () => {
  it('完整包校验通过,manifestHash 与链根一致', async () => {
    const pack = buildEvidencePack(input);
    const manifest = pack.files.find((f) => f.path.endsWith('integrity.sha256'))!.body;
    const byName = new Map(pack.files.filter((f) => !f.path.endsWith('integrity.sha256')).map((f) => [f.path.replace('evidence/run-1/', ''), f.body]));
    const r = await verifyEvidencePack(manifest, (name) => Promise.resolve(byName.get(name) ?? null));
    expect(r.ok).toBe(true);
    expect(r.broken).toEqual([]);
    expect(r.manifestHash).toBe(pack.manifestHash);
  });

  it('内容被篡改或文件缺失时列出 broken,ok=false', async () => {
    const pack = buildEvidencePack(input);
    const manifest = pack.files.find((f) => f.path.endsWith('integrity.sha256'))!.body;
    const byName = new Map(pack.files.filter((f) => !f.path.endsWith('integrity.sha256')).map((f) => [f.path.replace('evidence/run-1/', ''), f.body]));
    byName.set('answer.json', Buffer.from('tampered'));
    byName.delete('meta.json');
    const r = await verifyEvidencePack(manifest, (name) => Promise.resolve(byName.get(name) ?? null));
    expect(r.ok).toBe(false);
    expect(r.broken).toContain('answer.json');
    expect(r.broken).toContain('meta.json');
  });
});
