import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { currentAccount } from '../common/auth';

/**
 * 平台管理员守卫:挂在全局 JwtAuthGuard 之后使用,仅放行 role=admin 的账号。
 * 角色来自 JWT payload(登录时由 ADMIN_PHONES 名单授予)。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (currentAccount(req).role !== 'admin') {
      throw new ForbiddenException('需要平台管理员权限');
    }
    return true;
  }
}
