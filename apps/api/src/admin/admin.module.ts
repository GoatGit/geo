import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { SkillAccessController, SkillApiKeyGuard } from './skill-access.controller';
import { AdminGuard } from './admin.guard';

@Module({
  controllers: [AdminController, SkillAccessController],
  providers: [AdminGuard, SkillApiKeyGuard],
})
export class AdminModule {}
