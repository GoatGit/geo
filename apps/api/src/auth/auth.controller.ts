import { Body, Controller, Get, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsPhoneNumber, IsString, Length } from 'class-validator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Inject } from '@nestjs/common';
import { Public, currentAccount, signAccessToken, signRefreshToken, verifyRefreshToken } from '../common/auth';
import { DB } from '../common/infra.module';
import { AuthService } from './auth.service';
import { loadEnv } from '../config/env';

class SendCodeDto {
  @IsPhoneNumber('CN')
  phone!: string;
}

class VerifyCodeDto extends SendCodeDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(DB) private readonly db: NodePgDatabase,
  ) {}

  @Public()
  @Post('sms/code')
  async sendCode(@Body() dto: SendCodeDto) {
    const { devCode } = await this.authService.sendLoginCode(dto.phone);
    return { sent: true, ...(devCode ? { devCode } : {}) };
  }

  @Public()
  @Post('sms/verify')
  async verify(@Body() dto: VerifyCodeDto) {
    const ok = await this.authService.verifyLoginCode(dto.phone, dto.code);
    if (!ok) throw new HttpException('验证码错误或已过期', HttpStatus.UNAUTHORIZED);
    const account = await this.authService.upsertAccountByPhone(dto.phone);
    return this.tokens(account);
  }

  @Public()
  @Post('token:refresh')
  async refresh(@Body() dto: RefreshDto) {
    const env = loadEnv();
    const principal = verifyRefreshToken(env, dto.refreshToken);
    return this.tokens(principal);
  }

  @Get('me')
  me(@Req() req: Request) {
    return currentAccount(req);
  }

  private tokens(account: { id: number; phone: string } | { accountId: number; phone: string }) {
    const env = loadEnv();
    const principal = {
      accountId: 'accountId' in account ? account.accountId : account.id,
      phone: account.phone,
    };
    return {
      accessToken: signAccessToken(env, principal),
      refreshToken: signRefreshToken(env, principal),
      account: principal,
    };
  }
}
