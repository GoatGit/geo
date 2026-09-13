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
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
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
  };
}
