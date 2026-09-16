import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { BillingModule } from '../billing/billing.module';
import { ReportsController } from './reports.controller';
import { ReportRenderService } from './render.service';

@Module({
  imports: [BrandsModule, BillingModule],
  controllers: [ReportsController],
  providers: [ReportRenderService],
})
export class ReportsModule {}
