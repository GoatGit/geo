import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/auth';
import { InfraModule } from './common/infra.module';
import { AuthModule } from './auth/auth.module';
import { BrandsModule } from './brands/brands.module';
import { QuestionsModule } from './questions/questions.module';
import { MonitorModule } from './monitor/monitor.module';
import { ReportsModule } from './reports/reports.module';
import { EventsModule } from './events/events.module';
import { AdminModule } from './admin/admin.module';
import { BillingModule } from './billing/billing.module';
import { InsightsModule } from './insights/insights.module';
import { RunsController } from './runs/runs.controller';
import { CollectionController } from './collection/collection.controller';
import { AccountController } from './account/account.controller';
import { RecognitionController } from './recognition/recognition.controller';

const miscControllers = [RunsController, CollectionController, AccountController, RecognitionController];

@Module({
  imports: [
    InfraModule,
    AuthModule,
    BrandsModule,
    QuestionsModule,
    MonitorModule,
    ReportsModule,
    EventsModule,
    AdminModule,
    BillingModule,
    InsightsModule,
  ],
  controllers: [...miscControllers],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
