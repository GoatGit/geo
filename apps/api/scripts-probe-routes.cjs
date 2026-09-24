const NestFactory = require('@nestjs/core').NestFactory;
const { AppModule } = require('./dist/app.module.js');
(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const server = app.getHttpAdapter().getInstance();
  const posts = server._router.stack.filter((l) => l.route && l.route.methods && l.route.methods.post).map((l) => 'POST ' + JSON.stringify(l.route.path));
  console.log(posts.filter((p) => p.includes('survey')).join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
