import 'reflect-metadata';
import { Catch, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { AppModule } from './src/app.module';

process.env.DATABASE_URL = 'postgres://geo:geo_dev@localhost:15432/geo';
process.env.REDIS_URL = 'redis://localhost:16379';

@Catch()
class StackFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    console.error('STACK >>>', exception);
    const res = host.switchToHttp().getResponse();
    res.status(500).json({ error: { message: String(exception) } });
  }
}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: true });
  app.useGlobalFilters(new StackFilter());
  await app.init();
  const server = app.getHttpServer() as Server;
  await new Promise<void>((r) => server.listen(3902, r));
  console.log('boot ok on 3902');
}
void main();
