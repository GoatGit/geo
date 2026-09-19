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
    return this.insights.hub(currentAccount(req).accountId, currentAccount(req).role === 'admin');
  }

  /** 用户申请开通自己品牌所在的行业洞察(行业记录幂等创建,平台随后配置监测数据)。 */
  /** 自服务:新增我的行业(不再要求与品牌行业一致,创建即归属本人)。 */
  @Post('industries')
  createMine(@Req() req: Request, @Body() body: { name: string }) {
    return this.insights.createIndustryForAccount(currentAccount(req).accountId, String(body?.name ?? ''));
  }

  /** 自服务:删除我的自建行业(有报告时需先删报告;平台公共行业不可删)。 */
  @Delete('industries/:id')
  removeMine(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.removeIndustryForAccount(currentAccount(req).accountId, id);
  }

  @Post('industries/apply')
  applyIndustry(@Req() req: Request, @Body() body: { industry?: string }) {
    const name = String(body?.industry ?? '').trim().slice(0, 40);
    if (!name) throw new HttpException('industry is required', HttpStatus.BAD_REQUEST);
    return this.insights.applyIndustry(currentAccount(req).accountId, name, currentAccount(req).role === 'admin');
  }

  /** 用户触发生成(限本人品牌行业,12h 频控)。 */
  @Get('industries/:id/brands')
  myBrands(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.assertOwnedThen(id, currentAccount(req).accountId, () => this.insights.listIndustryBrands(id));
  }

  @Post('industries/:id/suggest-brands')
  mySuggestBrands(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.suggestBrandsForAccount(currentAccount(req).accountId, id);
  }

  @Post('industries/:id/brands')
  myCreateBrands(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { brands?: Array<{ name: string; website?: string; aliases?: string[]; positioning?: string }> },
  ) {
    const list = (body?.brands ?? []).filter((b) => b && String(b.name ?? '').trim().length >= 2).slice(0, 8);
    return this.insights.createBrandsForAccount(currentAccount(req).accountId, id, list);
  }

  @Delete('industries/:id/brands/:brandId')
  myRemoveBrand(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('brandId', ParseIntPipe) brandId: number,
  ) {
    return this.insights.removeBrandForAccount(currentAccount(req).accountId, id, brandId);
  }

  @Post('industries/:id/brands/:brandId/discover-website')
  myDiscoverWebsite(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('brandId', ParseIntPipe) brandId: number,
  ) {
    return this.insights.discoverWebsiteForAccount(currentAccount(req).accountId, id, brandId);
  }

  @Get('industries/:id/questions')
  myQuestions(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.assertOwnedThen(id, currentAccount(req).accountId, () => this.insights.listIndustryQuestions(id));
  }

  @Post('industries/:id/questions/manual')
  myAddQuestion(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { text: string; type: 'ranking' | 'reputation'; layer?: string | null },
  ) {
    return this.insights.addQuestionForAccount(
      currentAccount(req).accountId,
      id,
      dto.text,
      dto.type === 'reputation' ? 'reputation' : 'ranking',
      dto.layer ?? null,
    );
  }

  @Post('industries/:id/questions')
  mySuggestQuestions(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { apply?: boolean },
  ) {
    return this.insights.suggestQuestionsForAccount(currentAccount(req).accountId, id, Boolean(body?.apply));
  }

  @Delete('industries/:id/questions/:qid')
  myRemoveQuestion(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('qid', ParseIntPipe) qid: number,
  ) {
    return this.insights.removeQuestionForAccount(currentAccount(req).accountId, id, qid);
  }

  @Post('industries/:id/collect')
  myCollect(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.collectNowForAccount(currentAccount(req).accountId, id);
  }

  /** 订阅行业(0014 跨行业洞察):公共/他人行业可订阅,配额挂套餐;管理员豁免。 */
  @Post('industries/:id/subscribe')
  subscribe(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.subscribeIndustry(currentAccount(req).accountId, id, currentAccount(req).role === 'admin');
  }

  /** 退订行业(自建行业走删除)。 */
  @Delete('industries/:id/subscribe')
  unsubscribe(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.insights.unsubscribeIndustry(currentAccount(req).accountId, id);
  }

  @Post('industries/:id/run')
  runForMe(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { windowDays?: number | null },
  ) {
    const wd = body?.windowDays == null ? null : Math.min(Math.max(Number(body.windowDays), 1), 90);
    return this.insights.runForAccount(currentAccount(req).accountId, id, wd, currentAccount(req).role === 'admin');
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

  /**
   * 1.5 数字下钻(rubric docs/10):报告事实明细分页——mention 命中记录(含回答摘录)
   * 与 citation 引用记录;过滤参数 subject/layer/engine/domain/bucket 来自块元数据 drill。
   * 访问控制同详情:已发布匿名可查,草稿须本人/订阅/管理员。
   */
  @Public()
  @Get(':id/facts')
  async facts(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query()
    q: {
      kind?: string;
      subject?: string;
      layer?: string;
      engine?: string;
      domain?: string;
      bucket?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const accountId = optionalAccountId(req);
    const res = await this.insights.factsFor(accountId, id, {
      kind: q.kind === 'citations' ? 'citations' : 'mentions',
      subject: q.subject || undefined,
      layer: q.layer || undefined,
      engine: q.engine || undefined,
      domain: q.domain || undefined,
      bucket: q.bucket || undefined,
      page: Math.max(1, Number(q.page) || 1),
      pageSize: Math.min(100, Math.max(5, Number(q.pageSize) || 20)),
    });
    if (!res) throw new HttpException('报告不存在或未发布', HttpStatus.NOT_FOUND);
    return res;
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


  /** 分享审核:待审列表(用户提交的分享)。 */
  @Get('shares')
  shares() {
    return this.insights.pendingShares();
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
