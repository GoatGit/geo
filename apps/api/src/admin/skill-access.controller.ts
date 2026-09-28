import { Body, Controller, Get, Inject, Param, ParseIntPipe, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CanActivate, ExecutionContext, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { accountProfiles } from '@geo/db';
import { loadPlatformSettings } from '@geo/db';
import { DB } from '../common/infra.module';
import { Public } from '../common/auth';

/**
 * 机器接口守卫(智能体登录技能等):X-API-Key 匹配全局配置 skillAccess.key,
 * 或携带管理员 JWT(管理后台/脚本调试两用)。Key 为空 = 未启用,一律拒绝。
 */
@Injectable()
export class SkillApiKeyGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const account = req['account'] as { role?: string } | undefined;
    if (account?.role === 'admin') return true;
    const key = String(req.header('x-api-key') ?? '').trim();
    if (!key) throw new UnauthorizedException('缺少 X-API-Key(管理后台全局配置生成)');
    const settings = await loadPlatformSettings(this.db);
    if (!settings.skillAccess.key || key !== settings.skillAccess.key) {
      throw new UnauthorizedException('API Key 无效');
    }
    return true;
  }
}

/**
 * 机器接口(智能体登录技能,0053):不走全局 JWT(@Public),由 SkillApiKeyGuard 鉴权。
 * 与 AdminGuard 控制器分离——技能 Key 只放行机器面端点,不扩散到整个 admin API。
 */
@UseGuards(SkillApiKeyGuard)
@Controller('admin')
export class SkillAccessController {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  /** 读取档案登录上下文:本地智能体据此用同一指纹/出口/Context 直连远程浏览器。 */
  @Public()
  @Get('accounts/:id/login-context')
  async loginContext(@Param('id', ParseIntPipe) id: number) {
    const profile = (await this.db.select({
      id: accountProfiles.id,
      engine: accountProfiles.engine,
      fingerprint: accountProfiles.fingerprint,
      proxyServer: accountProfiles.proxyServer,
      proxyHint: accountProfiles.proxyHint,
      contextRef: accountProfiles.contextRef,
      status: accountProfiles.status,
    }).from(accountProfiles).where(eq(accountProfiles.id, id)).limit(1))[0];
    if (!profile) throw new NotFoundException('账号档案不存在');
    return profile;
  }

  /**
   * 凭证回收入池:字段与 worker 登录成功写状态完全一致(status available +
   * cookies/storageState + Context/出口绑定);空 Cookie 拒绝(采集依赖完整登录 Cookie)。
   */
  @Public()
  @Post('accounts/:id/credentials')
  async ingestCredentials(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      storageState?: { cookies?: Array<Record<string, unknown>>; origins?: unknown[] } | null;
      cookies?: Array<Record<string, unknown>>;
      contextId?: string;
      proxyServer?: string | null;
    },
  ) {
    const cookies = body.storageState?.cookies?.length ? body.storageState.cookies : body.cookies ?? [];
    if (!cookies.length) throw new BadRequestException('cookies 为空,拒绝入池(采集依赖完整登录 Cookie)');
    const storageState = body.storageState ?? { cookies, origins: [] };
    const profile = (await this.db.select({ id: accountProfiles.id }).from(accountProfiles).where(eq(accountProfiles.id, id)).limit(1))[0];
    if (!profile) throw new NotFoundException('账号档案不存在');
    await this.db.update(accountProfiles).set({
      status: 'available',
      cookies: cookies as unknown[],
      storageState: storageState as typeof accountProfiles.$inferInsert.storageState,
      ...(body.contextId ? { contextRef: body.contextId } : {}),
      ...(body.proxyServer !== undefined ? { proxyServer: body.proxyServer } : {}),
      cooldownUntil: null,
      healthScore: 100,
    }).where(eq(accountProfiles.id, id));
    return { ok: true, profileId: id, cookies: cookies.length };
  }
}
