import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { currentAccount, Public } from '../common/auth';
import { InsightsService, type UpsertInsightInput } from './insights.service';

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

/**
 * 行业洞察(docs/01 §3.10 扩展):
 * - 公开:首页精选(featured)与报告详情(已发布)——引流入口,无需登录
 * - 会员:总览板块取全部已发布报告
 * - 管理员:行业配置与报告 CRUD(AdminGuard)
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

  @Get()
  list() {
    return this.insights.adminList();
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.insights.adminGet(id);
  }

  @Post()
  create(@Body() dto: UpsertInsightDto) {
    return this.insights.create(dto as unknown as UpsertInsightInput);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<UpsertInsightDto>) {
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
