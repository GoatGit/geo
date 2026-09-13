import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { ReportsController } from './reports.controller';

@Module({
  imports: [BrandsModule],
  controllers: [ReportsController],
})
export class ReportsModule {}
