import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  // 生产环境启动即执行幂等 SQL 迁移 + 分区预建(docs/07 §13:发布流水线可替代)
  if (process.env.AUTO_MIGRATE === '1') {
    const { createDb, runMigrations, ensurePartitions } = await import('@geo/db');
    const pool = createDb(env.databaseUrl, 2).pool;
    await runMigrations(pool);
    await ensurePartitions(pool);
    await pool.end();
    new Logger('migrate').log('migrations + partitions ready');
  }
  (globalThis as { __geoEnv?: unknown }).__geoEnv = env;

  // rawBody:微信支付回调需对原始报文验签(docs/07 §9 STS/验签语义)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new AppExceptionFilter());
  // CORS:生产仅放行显式配置的站点域名(ALLOWED_ORIGIN,逗号分隔);未配置则关闭跨域
  const allowedOrigins = (env as typeof env & { allowedOrigin?: string }).allowedOrigin
    ? String((env as { allowedOrigin?: string }).allowedOrigin).split(',').map((s) => s.trim()).filter(Boolean)
    : (process.env.ALLOWED_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: env.nodeEnv === 'production' ? (allowedOrigins.length > 0 ? allowedOrigins : false) : true,
    credentials: true,
  });
  app.set('trust proxy', 1);
  // SIGTERM/SIGINT 触发 Nest 生命周期(onModuleDestroy 关闭 Queue/Redis),SAE 滚动发布时干净退出
  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');
  new Logger('bootstrap').log(`青柠GEO API listening on :${env.port} (${env.nodeEnv})`);
}

void bootstrap();
