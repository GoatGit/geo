import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
import { BrandsService } from '../brands/brands.service';
import { MonitorService } from './monitor.service';

@Controller('monitor')
export class MonitorController {
  constructor(
    private readonly monitorService: MonitorService,
    private readonly brandsService: BrandsService,
  ) {}

  private async owned(req: Request, id: number) {
    // 统一入口校验:NaN/非正整数直接 400,避免脏参落库报 bigint 500
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('brand 参数非法');
    await this.brandsService.getOwned(currentAccount(req).accountId, id);
  }

  /** 周期选择器自适应由前端调用:默认今日(进行中)→ 无数据回退最近完成日(docs/02 §8)。 */
  @Get('rankings')
  async rankings(
    @Req() req: Request,
    @Query('brand') brand: string,
    @Query('days') days = '1',
    @Query('engine') engine?: string,
  ) {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    const d = Math.min(Math.max(Number(days) || 1, 1), 180);
    return this.monitorService.rankings({
      brandId,
      days: d,
      engine: engine as never,
    });
  }

  @Get('funnel')
  async funnel(@Req() req: Request, @Query('brand') brand: string, @Query('days') days = '7') {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    const r = await this.monitorService.rankings({ brandId, days: Number(days) || 7 });
    return { funnel: r.funnel, excluded: r.excluded, asOf: r.asOf, source: r.source };
  }

  @Get('competitors')
  async competitors(@Req() req: Request, @Query('brand') brand: string, @Query('days') days = '7') {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    return this.monitorService.competitors(brandId, Number(days) || 7);
  }

  /** 竞品×引擎 分引擎对比矩阵(docs/01 §3.4)。 */
  @Get('competitors/matrix')
  async competitorsMatrix(@Req() req: Request, @Query('brand') brand: string, @Query('days') days = '7') {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    return this.monitorService.competitorsMatrix(brandId, Number(days) || 7);
  }

  @Get('citations')
  async citations(
    @Req() req: Request,
    @Query('brand') brand: string,
    @Query('days') days = '7',
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    const p = Math.min(Math.max(Number(page) || 1, 1), 500);
    const size = Math.min(Math.max(Number(pageSize) || 20, 5), 100);
    return this.monitorService.citations(brandId, Number(days) || 7, p, size);
  }

  @Get('reputation')
  async reputation(@Req() req: Request, @Query('brand') brand: string, @Query('days') days = '7') {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    return this.monitorService.reputation(brandId, Number(days) || 7);
  }

  @Get('actions')
  async actions(@Req() req: Request, @Query('brand') brand: string, @Query('days') days = '7') {
    const brandId = Number(brand);
    await this.owned(req, brandId);
    return this.monitorService.actionList(brandId, Number(days) || 7);
  }
}
