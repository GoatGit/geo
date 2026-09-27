import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
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

  @Post('brands/:id/questions:batch')
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
