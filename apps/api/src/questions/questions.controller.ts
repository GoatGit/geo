import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
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
  constructor(private readonly questionsService: QuestionsService) {}

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
    return this.questionsService.list(currentAccount(req).accountId, brandId);
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
