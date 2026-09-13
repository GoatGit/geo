import { createHash } from 'node:crypto';
import type { AskStatus, RawCitation } from '@geo/shared';

export const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

export interface EvidenceInput {
  runId: string;
  brandId: number;
  engine: string;
  surface: string;
  adapterVersion: string;
  question: string;
  /** 账号指纹哈希(不落原文,docs/07 §10) */
  accountFingerprint: string;
  egressIp?: string;
  status: AskStatus;
  answerText: string;
  rawHtml?: string | null;
  citations: RawCitation[];
  timing: { queuedAt: string; firstTokenAt: string; completedAt: string };
  engineMeta?: Record<string, unknown>;
  /** CDP Page.startScreencast 截帧(worker 层采集后传入;ffmpeg 合成 mp4 为可选后处理) */
  frames?: Array<{ index: number; capturedAt: string; dataBase64: string }>;
}

export interface EvidencePack {
  /** 对象存储前缀,evidence/{runId} */
  prefix: string;
  files: Array<{ path: string; body: Buffer }>;
  /** integrity.sha256 自身的哈希 = 证据链根(docs/04 §4 evidence_hash) */
  manifestHash: string;
  refs: { answerRef: string; snapshotRef: string; recordingRef: string | null };
}

/**
 * 证据包(docs/04 §4):
 * evidence/{runId}/answer.json · raw.html · meta.json · integrity.sha256
 * - meta 不含账号原文,只有指纹哈希与时间轴
 * - integrity.sha256 列出其余文件内容哈希;manifestHash 作为 query_runs.evidence_hash
 * - 录屏:CDP 截帧序列随包落存;mp4 合成(ffmpeg)为部署侧可选后处理
 */
export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const prefix = `evidence/${input.runId}`;
  const files: Array<{ path: string; body: Buffer }> = [];

  const answer = {
    runId: input.runId,
    brandId: input.brandId,
    engine: input.engine,
    surface: input.surface,
    question: input.question,
    status: input.status,
    answerText: input.answerText,
    citations: input.citations,
    timings: input.timing,
  };
  files.push({ path: `${prefix}/answer.json`, body: Buffer.from(JSON.stringify(answer, null, 2)) });

  if (input.rawHtml) {
    files.push({ path: `${prefix}/raw.html`, body: Buffer.from(input.rawHtml, 'utf8') });
  }

  const meta = {
    engine: input.engine,
    surface: input.surface,
    adapterVersion: input.adapterVersion,
    questionHash: sha256(input.question),
    accountFingerprint: input.accountFingerprint,
    egressIp: input.egressIp ?? null,
    timing: input.timing,
    engineMeta: input.engineMeta ?? {},
    frameCount: input.frames?.length ?? 0,
  };
  files.push({ path: `${prefix}/meta.json`, body: Buffer.from(JSON.stringify(meta, null, 2)) });

  for (const frame of input.frames ?? []) {
    files.push({
      path: `${prefix}/recording/frames/${String(frame.index).padStart(6, '0')}.jpg`,
      body: Buffer.from(frame.dataBase64, 'base64'),
    });
  }
  if ((input.frames?.length ?? 0) > 0) {
    const framesMeta = {
      note: 'CDP Page.startScreencast 截帧序列;Playwright recordVideo 在 connectOverCDP 下不可用(docs/07 §4.3)',
      frames: input.frames!.map((f) => ({ index: f.index, capturedAt: f.capturedAt })),
    };
    files.push({
      path: `${prefix}/recording/frames.json`,
      body: Buffer.from(JSON.stringify(framesMeta, null, 2)),
    });
  }

  // integrity.sha256:除自身外全部文件
  const manifest =
    files.map((f) => `${sha256(f.body)}  ${f.path.replace(`${prefix}/`, '')}`).join('\n') + '\n';
  const manifestBody = Buffer.from(manifest, 'utf8');
  files.push({ path: `${prefix}/integrity.sha256`, body: manifestBody });

  return {
    prefix,
    files,
    manifestHash: sha256(manifestBody),
    refs: {
      answerRef: `${prefix}/answer.json`,
      snapshotRef: input.rawHtml ? `${prefix}/raw.html` : `${prefix}/answer.json`,
      recordingRef: (input.frames?.length ?? 0) > 0 ? `${prefix}/recording/` : null,
    },
  };
}
