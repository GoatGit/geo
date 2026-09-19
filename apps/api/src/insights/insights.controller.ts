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
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { currentAccount, Public, verifyAccessToken } from '../common/auth';
import { loadEnv } from '../config/env';
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

  @IsOptional() @IsString() @MaxLength(400)
  disclosure?: string;
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

  /** 用户 hub:我的行业洞察(含生成/分享态)+ 官方发布流(我的在前)。 */
  @Get('hub')
  hub(@Req() req: Request) {
    return this.insights.hub(currentAccount(req).accountId);
  }

  /** 用户触发生成(限本人品牌行业,12h 频控)。 */
  @Post('industries/:id/run')
  runForMe(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { windowDays?: number | null },
  ) {
    const wd = body?.windowDays == null ? null : Math.min(Math.max(Number(body.windowDays), 1), 90);
    return this.insights.runForAccount(currentAccount(req).accountId, id, wd);
  }

  /** 用户提交分享:进入平台审核流,通过后发布到官网首页。 */
  @Post(':id/share')
  share(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: { note?: string }) {
    return this.insights.submitShare(currentAccount(req).accountId, id, body?.note);
  }

  /** 详情:已发布公开;未发布的仅本人行业可见(可选 Bearer 手动解析,公开链接匿名可达)。 */
  @Public()
  @Get(':id')
  async detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const accountId = optionalAccountId(req);
    if (accountId == null) return this.insights.publishedDetail(id);
    const found = await this.insights.detailFor(accountId, id);
    if (!found) return this.insights.publishedDetail(id);
    return this.insights.adminGet(id);
  }

  @Get()
  list(@Req() req: Request, @Query('industry') industry?: string) {
    void currentAccount(req);
    return this.insights.publishedList(industry ? Number(industry) : undefined);
  }

  /** PDF:同详情访问控制(已发布公开,草稿本人行业)。 */
  @Public()
  @Get(':id/pdf')
  async pdf(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const accountId = optionalAccountId(req);
    if (accountId != null) {
      const found = await this.insights.detailFor(accountId, id);
      if (found && found.mine) {
        await sendPdf(res, found.row as never);
        return;
      }
    }
    const detail = await this.insights.publishedDetail(id);
    await sendPdf(res, detail);
  }
}

/** 公开路由上的可选身份:无/坏 token 返回 null(不抛 401,公开链接匿名可达)。 */
function optionalAccountId(req: Request): number | null {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyAccessToken(loadEnv(), header.slice(7)).accountId;
  } catch {
    return null;
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

  // ===== 向导步骤②:行业品牌(独立模型) =====

  @Get('industries/:id/brands')
  industryBrands(@Param('id', ParseIntPipe) id: number) {
    return this.insights.listIndustryBrands(id);
  }

  @Post('industries/:id/suggest-brands')
  suggestBrands(@Param('id', ParseIntPipe) id: number) {
    return this.insights.suggestIndustryBrands(id);
  }

  /** 收录行业品牌(勾选的 AI 建议/手动):写 insight_brands,不占租户配额。 */
  @Post('industries/:id/brands')
  createBrands(@Param('id', ParseIntPipe) id: number, @Body() dto: { brands?: Array<{ name: string; website?: string; aliases?: string[]; positioning?: string }> }) {
    const list = (dto?.brands ?? []).filter((b) => b && String(b.name ?? '').trim().length >= 2).slice(0, 8);
    if (list.length === 0) throw new HttpException('未提供有效品牌', HttpStatus.BAD_REQUEST);
    return this.insights.createIndustryBrands(id, list);
  }

  @Delete('industries/:id/brands/:brandId')
  removeBrand(@Param('id', ParseIntPipe) id: number, @Param('brandId', ParseIntPipe) brandId: number) {
    return this.insights.removeIndustryBrand(id, brandId);
  }

  /** 官网自动发现(品牌资产精品化):LLM 提议候选 → 探测验证通过才落库。 */
  @Post('industries/:id/brands/:brandId/discover-website')
  discoverWebsite(
    @Param('id', ParseIntPipe) id: number,
    @Param('brandId', ParseIntPipe) brandId: number,
  ) {
    return this.insights.discoverIndustryBrandWebsite(id, brandId);
  }

  // ===== 向导步骤③:行业问题(单份) =====

  @Get('industries/:id/questions')
  industryQuestions(@Param('id', ParseIntPipe) id: number) {
    return this.insights.listIndustryQuestions(id);
  }

  @Post('industries/:id/questions/manual')
  addQuestion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { text: string; type: 'ranking' | 'reputation'; layer?: string | null },
  ) {
    return this.insights.addIndustryQuestion(id, dto.text, dto.type === 'reputation' ? 'reputation' : 'ranking', dto.layer ?? null);
  }

  @Delete('industries/:id/questions/:qid')
  removeQuestion(@Param('id', ParseIntPipe) id: number, @Param('qid', ParseIntPipe) qid: number) {
    return this.insights.removeIndustryQuestionRow(id, qid);
  }

  /** 「立即采集」:同步影子品牌(识别口径=行业品牌/问题=行业问题)并触发一轮采集。 */
  @Post('industries/:id/collect')
  collectNow(@Param('id', ParseIntPipe) id: number) {
    return this.insights.collectNow(id);
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

  /** 分享审核:待审列表(用户提交的分享)。 */
  @Get('shares')
  shares() {
    return this.insights.pendingShares();
  }

  /** 审核动作:approve → 发布上官网首页;reject → 带理由退回。 */
  @Post(':id/review')
  review(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { approve?: boolean; note?: string },
  ) {
    return this.insights.review(id, Boolean(body?.approve), body?.note, currentAccount(req).accountId);
  }
}
