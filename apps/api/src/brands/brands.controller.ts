import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';
import { BrandsService } from './brands.service';

class CreateBrandDto {
  @IsString()
  @MaxLength(600)
  description!: string;

  @IsOptional()
  @IsString()
  plan?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  dummy?: number;
}

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateBrandDto) {
    const account = currentAccount(req);
    return this.brandsService.create({
      accountId: account.accountId,
      description: dto.description,
      plan: dto.plan as never,
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
}
