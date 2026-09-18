import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { currentAccount, Public } from '../common/auth';
import { InsightsService, type UpsertInsightInput } from './insights.service';
import { renderInsightPdf, type PdfInsight } from './insight-pdf';

/** 生成并以下载形式回送 PDF(两个控制器共用)。 */
async function sendPdf(res: Response, detail: PdfInsight) {
  if ((detail.buildStatus ?? 'idle') === 'running') {
    throw new HttpException('洞察数据聚合进行中,请稍候再下载', HttpStatus.CONFLICT);
  }
  if (!detail.blocks?.length) {
    throw new HttpException('报告还没有内容:先在管理后台「运行」生成数据', HttpStatus.CONFLICT);
  }
  const buffer = await renderInsightPdf(detail);
  const name = `青柠GEO-行业洞察-${detail.industry}-${detail.issue || detail.id}.pdf`;
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="insight-${detail.id}.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('content-length', String(buffer.length));
  res.end(buffer);
}

class CreateIndustryDto {
  @IsString() @MinLength(1)
  name!: string;

  @IsOptional() @IsInt()
  sort?: number;
}

class UpdateIndustryDto {
  @IsOptional() @IsString() @MinLength(1)
  name?: string;

  @IsOptional() @IsInt()
  sort?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

class RunInsightDto {
  /** 聚合窗口天数;缺省 = 全量历史 */
  @IsOptional() @IsInt() @Min(1) @Max(365)
  windowDays?: number;
}

class UpsertInsightDto {
  @IsInt()
  industryId!: number;

  @IsString() @MinLength(1)
  title!: string;

  @IsOptional() @IsString()
  issue?: string;

  @IsOptional() @IsString()
  summary?: string;

  @IsOptional() @IsObject()
  cover?: Record<string, unknown>;

  @IsOptional() @IsArray()
  blocks?: Array<Record<string, unknown>>;

  @IsOptional() @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';

  @IsOptional() @IsBoolean()
  featured?: boolean;
}

/** PATCH 专用:全字段可选(ValidationPipe 按类元数据校验,Partial<T> 类型别名不生效)。 */
class UpdateInsightDto {
  @IsOptional() @IsInt()
  industryId?: number;

  @IsOptional() @IsString() @MinLength(1)
  title?: string;

  @IsOptional() @IsString()
  issue?: string;

  @IsOptional() @IsString()
  summary?: string;

  @IsOptional() @IsObject()
  cover?: Record<string, unknown>;

  @IsOptional() @IsArray()
  blocks?: Array<Record<string, unknown>>;

  @IsOptional() @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';

  @IsOptional() @IsBoolean()
  featured?: boolean;
}

/**
 * 行业洞察(docs/01 §3.10 扩展):
 * - 公开:首页精选(featured)、报告详情与 PDF 下载(已发布)——引流入口,无需登录
 * - 会员:总览板块取全部已发布报告
 * - 管理员:行业配置(增/删/改/运行)与报告 CRUD、草稿 PDF(AdminGuard)
 */
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Public()
  @Get('featured')
  featured() {
    return this.insights.featured();
  }

  @Public()
  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.insights.publishedDetail(id);
  }

  @Get()
  list(@Req() req: Request, @Query('industry') industry?: string) {
    void currentAccount(req);
    return this.insights.publishedList(industry ? Number(industry) : undefined);
  }

  /** 已发布报告 PDF 下载(公开引流;草稿走 admin 端点)。 */
  @Public()
  @Get(':id/pdf')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const detail = await this.insights.publishedDetail(id);
    await sendPdf(res, detail);
  }
}

@Controller('admin/insights')
@UseGuards(AdminGuard)
export class AdminInsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('industries')
  industries() {
    return this.insights.listIndustries();
  }

  @Post('industries')
  createIndustry(@Body() dto: CreateIndustryDto) {
    return this.insights.createIndustry(dto.name, dto.sort);
  }

  @Patch('industries/:id')
  updateIndustry(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateIndustryDto) {
    return this.insights.updateIndustry(id, dto);
  }

  @Delete('industries/:id')
  deleteIndustry(@Param('id', ParseIntPipe) id: number) {
    return this.insights.deleteIndustry(id);
  }

  /** 行业级监测问题生成器:LLM 生成行业视角问题(格局/对比/口碑),apply=下发到行业全部品牌。 */
  @Post('industries/:id/questions')
  suggestQuestions(@Param('id', ParseIntPipe) id: number, @Body() dto: { apply?: boolean }) {
    return this.insights.suggestIndustryQuestions(id, Boolean(dto?.apply));
  }

  /** 运行行业洞察:数据聚合在 worker 队列执行,前端轮询 buildStatus。 */
  @Post('industries/:id/run')
  runIndustry(@Param('id', ParseIntPipe) id: number, @Body() dto: RunInsightDto) {
    return this.insights.runIndustry(id, dto.windowDays ?? null);
  }

  @Get()
  list() {
    return this.insights.adminList();
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.insights.adminGet(id);
  }

  @Get(':id/pdf')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const detail = await this.insights.adminGet(id);
    await sendPdf(res, detail);
  }

  @Post()
  create(@Body() dto: UpsertInsightDto) {
    return this.insights.create(dto as unknown as UpsertInsightInput);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInsightDto) {
    if (Object.keys(dto).length === 0) {
      throw new HttpException('空更新', HttpStatus.BAD_REQUEST);
    }
    return this.insights.update(id, dto as Partial<UpsertInsightInput>);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.insights.remove(id);
  }
}
