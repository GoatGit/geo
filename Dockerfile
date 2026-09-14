# GeoLens 应用镜像(web / api / worker 同一基础镜像,以启动命令区分)
# 部署目标:阿里云 SAE(docs/07 §3)——单应用多实例,按需弹性
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/metrics/package.json packages/metrics/
COPY packages/engine-adapters/package.json packages/engine-adapters/
COPY packages/browser-session/package.json packages/browser-session/
COPY packages/evidence/package.json packages/evidence/
COPY apps/api/package.json apps/api/
COPY apps/worker-web/package.json apps/worker-web/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG API_ORIGIN=http://localhost:3000
ENV API_ORIGIN=$API_ORIGIN
COPY . .
RUN pnpm -r build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# 默认启动 API;web 与 worker 在 SAE 控制台/CLI 配置启动命令覆盖:
#   api:    node apps/api/dist/main.js
#   worker: node apps/worker-web/dist/main.js
#   web:    node apps/web/node_modules/.bin/next start -p 3001 (或 standalone 产物)
CMD ["node", "apps/api/dist/main.js"]
