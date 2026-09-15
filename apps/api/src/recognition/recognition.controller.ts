import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { recognitionEntries } from '@geo/db';
import { currentAccount } from '../common/auth';
import { DB } from '../common/infra.module';
import { BrandsService } from '../brands/brands.service';
import { Inject } from '@nestjs/common';

class UpdateRecognitionDto {
  @IsOptional()
  @IsIn(['self', 'competitor'])
  kind?: 'self' | 'competitor';

  @IsString()
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsIn(['pending', 'accepted', 'rejected'])
  state?: string;
}

class ConfirmRecognitionDto {
  @IsBoolean()
  confirmed!: boolean;
}

@Controller('brands/:id/recognition')
export class RecognitionController {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase,
    private readonly brandsService: BrandsService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Param('id', ParseIntPipe) brandId: number) {
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);
    return this.db.select().from(recognitionEntries).where(eq(recognitionEntries.brandId, brandId));
  }

  /** 口径更新:upsert 后落版本快照(历史报告按版本复算,docs/research 03-B)。 */
  @Post()
  async upsert(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Body() dto: UpdateRecognitionDto,
  ) {
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);
    const kind = dto.kind ?? 'competitor';
    const aliases = dto.aliases ?? [];
    const existing = (
      await this.db
        .select()
        .from(recognitionEntries)
        .where(
          and(
            eq(recognitionEntries.brandId, brandId),
            eq(recognitionEntries.kind, kind),
            eq(recognitionEntries.name, dto.name),
          ),
        )
        .limit(1)
    )[0];

    if (existing) {
      await this.db
        .update(recognitionEntries)
        .set({ aliases, note: dto.note ?? existing.note, confirmed: true })
        .where(eq(recognitionEntries.id, existing.id));
    } else {
      await this.db.insert(recognitionEntries).values({
        brandId,
        kind,
        name: dto.name,
        aliases,
        note: dto.note,
        source: 'manual',
        confirmed: true,
      });
    }
    await this.brandsService.snapshotRecognition(brandId);
    return { saved: true };
  }

  /** 确认/驳回 AI 建议的口径条目(确认后参与识别;落版本快照)。 */
  @Patch(':entryId')
  async setConfirmed(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: ConfirmRecognitionDto,
  ) {
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);
    await this.db
      .update(recognitionEntries)
      .set({ confirmed: dto.confirmed })
      .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.id, entryId)));
    await this.brandsService.snapshotRecognition(brandId);
    return { saved: true };
  }

  /** 删除 AI 误建议的口径条目(如把噪声词识别成了竞品)。 */
  @Delete(':entryId')
  async removeEntry(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
  ) {
    await this.brandsService.getOwned(currentAccount(req).accountId, brandId);
    await this.db
      .delete(recognitionEntries)
      .where(and(eq(recognitionEntries.brandId, brandId), eq(recognitionEntries.id, entryId)));
    await this.brandsService.snapshotRecognition(brandId);
    return { deleted: true };
  }
}
