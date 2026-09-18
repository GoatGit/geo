import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS } from './infra.module';

export const RATE_LIMIT_KEY = 'rate-limit';

export interface RateLimitRule {
  /** 窗口内最大请求数 */
  max: number;
  /** 窗口秒数 */
  windowSec: number;
  /** 限流维度名(区分同一 IP 上不同端点的独立配额) */
  name: string;
}

/** 声明端点限流:按调用方 IP + 端点名计数(Redis INCR+EXPIRE 滑动窗口简化版)。 */
export const RateLimit = (max: number, windowSec: number, name: string) =>
  SetMetadata(RATE_LIMIT_KEY, { max, windowSec, name } satisfies RateLimitRule);

function clientIp(req: { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }): string {
  // 反代(SAE/SLB)场景取转发链首地址,无则回退直连地址
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0]?.trim() : undefined;
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * 公开端点限流(登录/验证码/支付回调等无鉴权面):
 * Redis 不可用时 fail-open(限流是防护层,不能反过来成为登录不可用的单点),但记录告警。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<RateLimitRule | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!rule) return true;
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      ip?: string;
      socket?: { remoteAddress?: string };
    }>();
    const key = `rl:${rule.name}:${clientIp(req)}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, rule.windowSec);
      if (n > rule.max) {
        throw new HttpException('请求过于频繁,请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      console.error(`[rate-limit] redis unavailable, fail-open: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }
}
