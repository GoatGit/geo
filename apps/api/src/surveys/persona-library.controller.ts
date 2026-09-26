import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { AdminGuard } from '../admin/admin.guard';
import { currentAccount } from '../common/auth';
import { PersonaLibraryService } from './persona-library.service';
class ImportDto { @IsInt() @Min(1) @Max(200000) count!: number; }
class EnrichDto { @IsInt() @Min(1) @Max(500) count!: number; }
@Controller('persona-library')
export class PersonaLibraryController {
  constructor(private readonly service: PersonaLibraryService) {}
  @Get() list(@Query('q') q?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.service.list(q, Number(offset ?? 0), status || undefined);
  }
  @Post('imports') @HttpCode(202) @UseGuards(AdminGuard)
  import(@Req() req: Request, @Body() body: ImportDto) { return this.service.startImport(currentAccount(req).accountId, body.count); }
  @Post('enrich') @HttpCode(202) @UseGuards(AdminGuard)
  enrich(@Body() body: EnrichDto) { return this.service.enrich(body.count); }
  /** 全量转化:未增强源描述一次性入队,worker 离线跑批消化(docs/11 §7)。 */
  @Post('enrich-all') @HttpCode(202) @UseGuards(AdminGuard)
  enrichAll() { return this.service.enrichAll(); }
}
