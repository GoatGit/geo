import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
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
  /** 可空:微信扫码登录的账号以 openid 为身份,手机号可后绑 */
  phone: string | null;
  /** 平台角色:'user' 租户 / 'admin' 平台运营;缺省按 user 处理(兼容旧 token) */
  role?: string;
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
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret) as AccountPrincipal & { exp: number };
    // phone 可空:微信扫码登录的账号以 wechat_openid 为身份,手机号可后绑
    if (!payload.accountId) throw new UnauthorizedException('invalid token payload');
    return { accountId: Number(payload.accountId), phone: payload.phone ?? null, role: payload.role };
  } catch (err) {
    // 过期/非法 token 统一 401(前端据此清会话跳登录),不落 500
    if (err instanceof UnauthorizedException) throw err;
    throw new UnauthorizedException('invalid or expired token');
  }
}

export function verifyRefreshToken(env: AppEnv, token: string): AccountPrincipal {
  try {
    const payload = jwt.verify(token, env.jwtRefreshSecret) as AccountPrincipal & { exp: number };
    if (!payload.accountId) throw new UnauthorizedException('invalid token payload');
    return { accountId: Number(payload.accountId), phone: payload.phone ?? null, role: payload.role };
  } catch {
    throw new UnauthorizedException('invalid or expired refresh token');
  }
}

/** 全局 Bearer JWT 守卫;@Public() 放行(auth/health)。
 *  注:不走 Reflector 构造注入——tsx(esbuild)不生成装饰器参数类型元数据,
 *  类型注入会得到 undefined(旧 dist 构建由 tsc 生成故未暴露);直接读 reflect-metadata。 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctx.getHandler());
    if (isPublic) return true;

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
