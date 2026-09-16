import { Controller, Get, HttpException, HttpStatus, Inject, Param, ParseIntPipe, Req } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { queryRuns } from '@geo/db';
import { createStorageFromEnv, type EvidenceStorage } from '@geo/evidence';
import { currentAccount } from '../common/auth';
import { DB } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';
import { EVIDENCE_SIGNED_URL_TTL } from '../config/consts';

/**
 * 证据包索引(docs/05 §6 GET /runs/:id/evidence):
 * 校验 run 归属 → 仅对实际存在的 ref 签发短时效 URL(docs/07 §9 STS 语义)。
 * local 实现返回 file://(dev);生产为对象存储签名 URL。
 */
@Controller('runs')
export class RunsController {
  private readonly storage: EvidenceStorage = createStorageFromEnv();

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    private readonly brandsService: BrandsService,
  ) {}

  @Get(':id/evidence')
  async evidence(@Req() req: Request, @Param('id', ParseIntPipe) runId: number) {
    const accountId = currentAccount(req).accountId;
    const run = (
      await this.db
        .select({
          brandId: queryRuns.brandId,
          status: queryRuns.status,
          answerRef: queryRuns.answerRef,
          snapshotRef: queryRuns.snapshotRef,
          recordingRef: queryRuns.recordingRef,
          evidenceHash: queryRuns.evidenceHash,
          ranAt: queryRuns.ranAt,
        })
        .from(queryRuns)
        .where(eq(queryRuns.id, runId))
        .limit(1)
    )[0];
    if (!run) throw new HttpException('采集记录不存在', HttpStatus.NOT_FOUND);
    await this.brandsService.getOwned(accountId, run.brandId);

    const ttl = Number(process.env.EVIDENCE_SIGNED_URL_TTL ?? EVIDENCE_SIGNED_URL_TTL);
    const candidates = [...new Set([run.answerRef, run.snapshotRef, run.recordingRef].filter((x): x is string => !!x))];
    const evidence: Array<{ key: string; url: string | null }> = [];
    for (const key of candidates) {
      try {
        evidence.push({ key, url: await this.storage.signedUrl(key, ttl) });
      } catch {
        evidence.push({ key, url: null });
      }
    }

    return {
      runId,
      status: run.status,
      ranAt: run.ranAt,
      // 快照 7 天保留(docs/01 §3.7);报告内引用的证据已随报告归档,不受此限
      snapshotNote:
        '原始快照按保留策略过期;报告引用的证据随报告 payload 归档,不受此限制',
      manifestHash: run.evidenceHash,
      evidence,
    };
  }

  /** 原文证据内容:直接返回 answer.json 解析结果(免前端二次取签名 URL;docs/05 §6)。 */
  @Get(':id/answer')
  async answer(@Req() req: Request, @Param('id', ParseIntPipe) runId: number) {
    const accountId = currentAccount(req).accountId;
    const run = (
      await this.db
        .select({
          brandId: queryRuns.brandId,
          status: queryRuns.status,
          engine: queryRuns.engine,
          ranAt: queryRuns.ranAt,
          questionId: queryRuns.questionId,
          answerRef: queryRuns.answerRef,
          evidenceHash: queryRuns.evidenceHash,
        })
        .from(queryRuns)
        .where(eq(queryRuns.id, runId))
        .limit(1)
    )[0];
    if (!run) throw new HttpException('采集记录不存在', HttpStatus.NOT_FOUND);
    await this.brandsService.getOwned(accountId, run.brandId);

    if (!run.answerRef) {
      throw new HttpException('该记录没有存证(失败/拦截任务不产生回答证据)', HttpStatus.NOT_FOUND);
    }
    let answer: {
      answerText?: string;
      citations?: Array<{ url: string; title?: string }>;
      question?: string;
      timings?: Record<string, string>;
    };
    try {
      answer = JSON.parse((await this.storage.get(run.answerRef)).toString('utf8'));
    } catch {
      throw new HttpException('证据包读取失败(可能已过保留期)', HttpStatus.GONE);
    }
    return {
      runId,
      status: run.status,
      engine: run.engine,
      ranAt: run.ranAt,
      questionId: run.questionId,
      question: answer.question ?? null,
      answerText: answer.answerText ?? '',
      citations: answer.citations ?? [],
      manifestHash: run.evidenceHash,
      answerRef: run.answerRef,
    };
  }
}
