import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
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

class CreateMaterialDto {
  @IsIn(['text', 'url'])
  kind!: 'text' | 'url';

  @IsString()
  @Length(1, 120)
  title!: string;

  @IsString()
  @MaxLength(20000)
  content!: string;
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

  /** 品牌资料库(docs/01 IA ④ 对标竞品品牌库):AI 写稿/问答/洞察时调用的参考资料。 */
  @Get(':id/materials')
  async materials(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    await this.brandsService.getOwned(currentAccount(req).accountId, id);
    return this.brandsService.listMaterials(id);
  }

  @Post(':id/materials')
  async addMaterial(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMaterialDto,
  ) {
    await this.brandsService.getOwned(currentAccount(req).accountId, id);
    return this.brandsService.addMaterial(id, dto.kind, dto.title, dto.content, 'manual');
  }

  @Delete('materials/:mid')
  async removeMaterial(@Req() req: Request, @Param('mid', ParseIntPipe) mid: number) {
    await this.brandsService.removeOwnedMaterial(currentAccount(req).accountId, mid);
    return { ok: true };
  }

  /** AI 品牌挖掘:基于现有档案(名称/行业/官网/描述)生成结构化品牌画像 + 建议竞品。
   *  产物自动入资料库(source='dig'),竞品建议走既有「待确认」机制,由用户确认后生效。 */
  @Post(':id/dig')
  async dig(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.brandsService.digProfile(currentAccount(req).accountId, id);
  }
}
