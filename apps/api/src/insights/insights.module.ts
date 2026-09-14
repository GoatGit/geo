import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AdminInsightsController, InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/** 行业洞察:展示侧(公开/会员)+ 管理侧(AdminGuard)同模块。 */
@Module({
  controllers: [InsightsController, AdminInsightsController],
  providers: [InsightsService, AdminGuard],
})
export class InsightsModule {}
