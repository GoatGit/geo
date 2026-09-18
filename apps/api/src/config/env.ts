/** 环境配置:集中读取与必填校验(生产要求显式声明,禁止静默默认密钥)。 */

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

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
  // 环境守卫:publicBaseUrl 意味着公网部署,而 dev 级 JWT 密钥/devCode/mock 支付只在
  // 非 production 生效——两者同现说明环境标记与真实部署意图不符(最危险的单点静默降级),
  // 直接拒绝启动,把问题拦在部署期而不是事故期
  if (publicBaseUrl && !isProd) {
    throw new Error(
      `PUBLIC_BASE_URL=${publicBaseUrl} 已配置但 NODE_ENV=${nodeEnv}:' +
        '公网部署必须显式 NODE_ENV=production(启用生产级密钥校验/关闭 devCode/mock 支付),否则拒绝启动`,
    );
  }
  if (!isProd && (!env.JWT_ACCESS_SECRET || !env.JWT_REFRESH_SECRET)) {
    console.warn(
      '[env] 非 production 且未显式配置 JWT 密钥:使用公开 dev 密钥(任何人可伪造 token),仅限本地开发',
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
