import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
import { BrandsService } from './brands.service';

class CreateBrandDto {
  @IsString()
  @MaxLength(600)
  description!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  dummy?: number;
}

class UpdateBrandDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  intro?: string;
}

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateBrandDto) {
    const account = currentAccount(req);
    // 档位一律跟随账号会员:不接受租户传入 plan(防提权,service 强制覆盖)
    return this.brandsService.create({
      accountId: account.accountId,
      description: dto.description,
    });
  }

  @Get()
  list(@Req() req: Request) {
    return this.brandsService.list(currentAccount(req).accountId);
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.brandsService.getOwned(currentAccount(req).accountId, id);
  }

  /** 品牌资料修改(品牌资产栏目):名称/行业/官网/描述;改名同步本品识别口径。 */
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brandsService.update(currentAccount(req).accountId, id, dto);
  }
}
