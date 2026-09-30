import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { BrandsService } from '../brands/brands.service';
import { QuestionsService } from './questions.service';

class QuestionItemDto {
  @IsString()
  @MaxLength(120)
  text!: string;

  @IsOptional()
  @IsIn(['ranking', 'reputation'])
  type?: 'ranking' | 'reputation';
}

class BatchQuestionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionItemDto)
  items!: QuestionItemDto[];
}

@Controller()
export class QuestionsController {
  constructor(
    private readonly questionsService: QuestionsService,
    private readonly brandsService: BrandsService,
  ) {}

  /** AI 推荐监控问题(冷启动/扩池):品牌档案+竞品+已有问题 → 差异化新问题候选。 */
  @Post('brands/:id/questions/suggest')
  @UseGuards(RateLimitGuard)
  @RateLimit(6, 60, 'questions-suggest')
  suggest(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Body() dto: { count?: number },
  ) {
    const count = Math.min(Math.max(Math.floor(Number(dto?.count) || 12), 4), 20);
    return this.questionsService.suggestForAccount(currentAccount(req).accountId, brandId, count);
  }

  @Post('brands/:id/questions/batch')
  async batch(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Body() dto: BatchQuestionsDto,
  ) {
    return this.questionsService.batchCreate({
      accountId: currentAccount(req).accountId,
      brandId,
      items: dto.items,
    });
  }

  @Get('brands/:id/questions')
  async list(@Req() req: Request, @Param('id', ParseIntPipe) brandId: number) {
    // 示例品牌可读(0020):先过可读校验,再按品牌取题(跳过套餐归属)
    await this.brandsService.getReadable(currentAccount(req).accountId, brandId);
    return this.questionsService.listForBrand(brandId);
  }

  @Get('brands/:id/quota')
  async quota(@Req() req: Request, @Param('id', ParseIntPipe) brandId: number) {
    return this.questionsService.quotaOf(currentAccount(req).accountId, brandId);
  }

  @Delete('brands/:id/questions/:qid')
  async remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) brandId: number,
    @Param('qid', ParseIntPipe) questionId: number,
  ) {
    return this.questionsService.deleteQuestion(currentAccount(req).accountId, brandId, questionId);
  }
}
