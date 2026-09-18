import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RateLimitGuard } from '../common/rate-limit.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, RateLimitGuard],
})
export class AuthModule {}
