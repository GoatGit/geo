import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadEnv, type AppEnv } from '../config/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: AccountPrincipal;
    }
  }
}

export interface AccountPrincipal {
  accountId: number;
  phone: string;
}

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export function signAccessToken(env: AppEnv, p: AccountPrincipal): string {
  return jwt.sign(p, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtl as never });
}

export function signRefreshToken(env: AppEnv, p: AccountPrincipal): string {
  return jwt.sign(p, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshTtl as never });
}

export function verifyAccessToken(env: AppEnv, token: string): AccountPrincipal {
  const payload = jwt.verify(token, env.jwtAccessSecret) as AccountPrincipal & { exp: number };
  if (!payload.accountId || !payload.phone) throw new UnauthorizedException('invalid token payload');
  return { accountId: Number(payload.accountId), phone: payload.phone };
}

export function verifyRefreshToken(env: AppEnv, token: string): AccountPrincipal {
  const payload = jwt.verify(token, env.jwtRefreshSecret) as AccountPrincipal & { exp: number };
  if (!payload.accountId || !payload.phone) throw new UnauthorizedException('invalid token payload');
  return { accountId: Number(payload.accountId), phone: payload.phone };
}

/** 全局 Bearer JWT 守卫;@Public() 放行(auth/health)。 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.get<boolean>(IS_PUBLIC_KEY, ctx.getHandler())) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('missing bearer token');
    req['account'] = verifyAccessToken(loadEnv(), token);
    return true;
  }
}

/** 已认证账号的提取(Nest 管道等价物,控制器内使用)。 */
export function currentAccount(req: Request): AccountPrincipal {
  const account = req['account'] as AccountPrincipal | undefined;
  if (!account) throw new UnauthorizedException();
  return account;
}
