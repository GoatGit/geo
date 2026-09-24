import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, Query, HttpCode } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsIn, IsString, MaxLength, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import type { PoolSpec, SurveyQuestion } from '@geo/db';
import { currentAccount } from '../common/auth';
import { CalibrationService } from './calibration.service';
import { SurveysService } from './surveys.service';

class CreateSurveyDto {
  @IsOptional() @IsInt() brandId?: number;
  @IsString() @MaxLength(120) title!: string;
  @IsString() @MaxLength(2000) objective!: string;
}

class UpdateQuestionsDto {
  @IsArray() questions!: SurveyQuestion[];
}

class SegmentDto {
  @IsString() ageBand!: string;
  @IsString() cityTier!: string;
  @IsString() incomeBand!: string;
  @IsString() gender!: string;
  @IsString() occupationGroup!: string;
  @IsInt() @Min(1) @Max(2000) count!: number;
}

class ApproveBodyDto {
  @IsBoolean() approved!: boolean;
}

class CreatePoolDto {
  @IsOptional() @IsIn(['generated', 'hybrid', 'persona_hub']) sourceMode?: 'generated' | 'hybrid' | 'persona_hub';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments!: PoolSpec['segments'];
}

@Controller()
export class SurveysController {
  constructor(private readonly surveysService: SurveysService, private readonly calibration: CalibrationService) {}

  @Post('surveys')
  create(@Req() req: Request, @Body() dto: CreateSurveyDto) {
    const { accountId } = currentAccount(req);
    return this.surveysService.create({ accountId, brandId: dto.brandId, title: dto.title, objective: dto.objective });
  }

  // Resource paths avoid Express interpreting action names as route parameters.
  @Post('surveys/:id/generate')
  @HttpCode(202)
  generate(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.generateSurvey({ accountId: currentAccount(req).accountId, surveyId });
  }

  @Post('surveys/:id/questions')
  updateQuestions(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number, @Body() dto: UpdateQuestionsDto) {
    return this.surveysService.updateQuestions({
      accountId: currentAccount(req).accountId,
      surveyId,
      questions: dto.questions,
    });
  }

  @Post('surveys/:id/pools')
  createPool(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number, @Body() dto: CreatePoolDto) {
    return this.surveysService.createPool({
      accountId: currentAccount(req).accountId,
      surveyId,
      spec: { segments: dto.segments }, sourceMode: dto.sourceMode,
    });
  }

  @Post('surveys/:id/pools/:poolId/approve')
  approvePool(
    @Req() req: Request,
    @Param('id', ParseIntPipe) surveyId: number,
    @Param('poolId', ParseIntPipe) poolId: number,
    @Body() dto: ApproveBodyDto,
  ) {
    return this.surveysService.approvePool({
      accountId: currentAccount(req).accountId,
      surveyId,
      poolId,
      approved: dto.approved,
    });
  }

  @Post('surveys/:id/run')
  @HttpCode(202)
  run(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.run({ accountId: currentAccount(req).accountId, surveyId });
  }

  @Get('surveys')
  list(@Req() req: Request) {
    return this.surveysService.list(currentAccount(req).accountId);
  }

  @Get('surveys/:id/report')
  report(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number, @Query('dimension') dimension?: string) {
    return this.surveysService.report(currentAccount(req).accountId, surveyId, dimension);
  }

  @Get('surveys/:id/pools')
  pools(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.pools(currentAccount(req).accountId, surveyId);
  }

  @Get('surveys-pools')
  allPools(@Req() req: Request) { return this.surveysService.pools(currentAccount(req).accountId); }

  @Get('surveys/:id')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.detail(currentAccount(req).accountId, surveyId);
  }

  @Post('surveys/:id/cancel')
  cancel(@Req() req: Request, @Param('id', ParseIntPipe) surveyId: number) {
    return this.surveysService.cancel(currentAccount(req).accountId, surveyId);
  }
  @Get('surveys/:id/calibrations')
  calibrations(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.calibration.list(currentAccount(req).accountId, id); }
  @Post('surveys/:id/calibrations')
  calibrate(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) { return this.calibration.calibrate(currentAccount(req).accountId, id, body); }

}
