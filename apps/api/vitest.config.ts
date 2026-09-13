import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // 单测不触库;仅满足 InfraModule 的模块级 env 校验
      DATABASE_URL: 'postgres://test:test@localhost:5/test',
      REDIS_URL: 'redis://localhost:5',
      NODE_ENV: 'test',
    },
  },
});
