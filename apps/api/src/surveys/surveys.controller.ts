import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import type { PoolSpec, SurveyQuestion } from '@geo/db';
import { currentAccount } from '../common/auth';
import { SurveysService } from './surveys.service';

class CreateSurveyDto {
  @IsOptional() @IsInt() brandId?: number;
  @IsString() @MaxLength(120) title!: string;
  @IsString() @MaxLength(2000) objective!: string;
}

class GenerateSurveyDto {
  @IsInt() surveyId!: number;
}

class UpdateQuestionsDto {
  @IsInt() surveyId!: number;
  @IsArray() questions!: SurveyQuestion[];
}

class SegmentDto {
  @IsString() ageBand!: string;
  @IsString() cityTier!: string;
  @IsString() incomeBand!: string;
  @IsString() gender!: string;
  @IsString() occupationGroup!: string;
  @IsInt() count!: number;
}

class CreatePoolDto {
  @IsInt() surveyId!: number;
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments!: PoolSpec['segments'];
}

class ApprovePoolDto {
  @IsInt() surveyId!: number;
  @IsInt() poolId!: number;
  @IsBoolean() approved!: boolean;
}

class RunSurveyDto {
  @IsInt() surveyId!: number;
}

@Controller()
export class SurveysController {
  constructor(private readonly surveysService: SurveysService) {}

  @Post('surveys')
  create(@Req() req: Request, @Body() dto: CreateSurveyDto) {
    const { accountId } = currentAccount(req);
    return this.surveysService.create({ accountId, brandId: dto.brandId, title: dto.title, objective: dto.objective });
  }

  @Post('surveys:generate')
  generate(@Req() req: Request, @Body() dto: GenerateSurveyDto) {
    return this.surveysService.generateSurvey({ accountId: currentAccount(req).accountId, surveyId: dto.surveyId });
  }

  @Post('surveys:questions')
  updateQuestions(@Req() req: Request, @Body() dto: UpdateQuestionsDto) {
    return this.surveysService.updateQuestions({
      accountId: currentAccount(req).accountId,
      surveyId: dto.surveyId,
      questions: dto.questions,
    });
  }

  @Post('surveys:pools')
  createPool(@Req() req: Request, @Body() dto: CreatePoolDto) {
    return this.surveysService.createPool({
      accountId: currentAccount(req).accountId,
      surveyId: dto.surveyId,
      spec: { segments: dto.segments },
    });
  }

  @Post('surveys:pools:approve')
  approvePool(@Req() req: Request, @Body() dto: ApprovePoolDto) {
    return this.surveysService.approvePool({
      accountId: currentAccount(req).accountId,
      surveyId: dto.surveyId,
      poolId: dto.poolId,
      approved: dto.approved,
    });
  }

  @Post('surveys:run')
  run(@Req() req: Request, @Body() dto: RunSurveyDto) {
    return this.surveysService.run({ accountId: currentAccount(req).accountId, surveyId: dto.surveyId });
  }

  @Get('surveys')
  list(@Req() req: Request) {
    return this.surveysService.list(currentAccount(req).accountId);
  }

  @Get('surveys/:id/report')
  report(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.report(currentAccount(req).accountId, surveyId);
  }

  @Get('surveys/:id/pools')
  pools(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.pools(currentAccount(req).accountId, surveyId);
  }
}
