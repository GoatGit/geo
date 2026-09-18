/** 环境配置:集中读取与必填校验(生产要求显式声明,禁止静默默认密钥)。 */

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

/** 环境告警只打一次(loadEnv 每请求都会被调用,不打标会刷爆日志)。 */
const warned = { devSecrets: false, publicMismatch: false };

function num(name: string, value: string | undefined, fallback: number): number {
  const v = value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(v) ? v : fallback;
}

export interface AppEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  smsProvider: 'console' | 'aliyun';
  evidenceStorage: 'local' | 's3';
  /** 平台管理员手机号(逗号分隔):登录注册时自动授予 admin 角色 */
  adminPhones: string[];
  /** 公网可达基址(支付回调 notify_url 拼接;为空时真实渠道无法接收异步通知) */
  publicBaseUrl: string;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? '';
  const hasExplicitSecrets = Boolean(env.JWT_ACCESS_SECRET && env.JWT_REFRESH_SECRET);
  // 环境守卫:公网部署 + 未显式配置 JWT 密钥 = 将以公开 dev 密钥签发 token(任何人可伪造
  // admin),这是不可辩护的组合,拒绝启动。注意:非 production 标记 + 显式密钥是合法形态
  // (如 NODE_ENV=staging 的灰度/生产环境,密钥齐全、行为差异仅 devCode/mock),只告警不拦截
  if (publicBaseUrl && !isProd && !hasExplicitSecrets) {
    throw new Error(
      `PUBLIC_BASE_URL=${publicBaseUrl} 公网部署但 NODE_ENV=${nodeEnv} 且未显式配置 JWT 密钥:` +
        '将以公开 dev 密钥签发可伪造 admin 的 token,拒绝启动(配置 JWT_ACCESS_SECRET/JWT_REFRESH_SECRET 或 NODE_ENV=production)',
    );
  }
  if (!isProd && !hasExplicitSecrets) {
    if (!warned.devSecrets) {
      warned.devSecrets = true;
      console.warn(
        '[env] 非 production 且未显式配置 JWT 密钥:使用公开 dev 密钥(任何人可伪造 token),仅限本地开发',
      );
    }
  }
  if (publicBaseUrl && !isProd && !warned.publicMismatch) {
    // 公网 + 非 production 标记:合法但必须让运营看到当前行为差异(devCode 直显登录、mock 支付可用)
    warned.publicMismatch = true;
    console.warn(
      `[env] PUBLIC_BASE_URL=${publicBaseUrl} 在 NODE_ENV=${nodeEnv} 下运行:` +
        'devCode 将随登录响应直显(短信登录可绕过)、支付渠道未配置时降级 mock——生产环境应设 NODE_ENV=production',
    );
  }
  return {
    nodeEnv,
    port: num('PORT', env.PORT, 3000),
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    redisUrl: required('REDIS_URL', env.REDIS_URL),
    jwtAccessSecret: isProd
      ? required('JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET)
      : (env.JWT_ACCESS_SECRET ?? 'dev-access-secret'),
    jwtRefreshSecret: isProd
      ? required('JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET)
      : (env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret'),
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '2h',
    jwtRefreshTtl: env.JWT_REFRESH_TTL ?? '30d',
    smsProvider: (env.SMS_PROVIDER as AppEnv['smsProvider']) ?? 'console',
    evidenceStorage: (env.EVIDENCE_STORAGE as AppEnv['evidenceStorage']) ?? 'local',
    adminPhones: (env.ADMIN_PHONES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicBaseUrl,
  };
}
