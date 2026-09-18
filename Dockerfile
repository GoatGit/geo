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
COPY packages/insight-agent/package.json packages/insight-agent/
COPY apps/api/package.json apps/api/
COPY apps/worker-web/package.json apps/worker-web/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG API_ORIGIN=http://localhost:3000
ENV API_ORIGIN=$API_ORIGIN
COPY . .
RUN pnpm -r build

# ---- runtime:仅生产依赖 + 构建产物,非 root 运行 ----
# 不再全量 COPY /app:源码、test/、docs 与 devDependencies(tsup/tsc/tsx/vitest/typescript)不进镜像。
# 取舍说明:web 未启用 next output:"standalone"(改源码超出本镜像改造范围),故 web 仍依赖
# workspace node_modules + .next 由 `next start` 启动;.next/cache 仅为增量构建加速,运行时不需要,剔除。
FROM node:24-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
WORKDIR /app
ENV NODE_ENV=production

# 只拷贝 manifest 骨架后装生产依赖(--prod 跳过 devDependencies);
# workspace node_modules 中的 symlink 指向 packages/* / apps/* 目录本身,故包目录结构必须保留。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/metrics/package.json packages/metrics/
COPY packages/engine-adapters/package.json packages/engine-adapters/
COPY packages/browser-session/package.json packages/browser-session/
COPY packages/evidence/package.json packages/evidence/
COPY packages/insight-agent/package.json packages/insight-agent/
COPY apps/api/package.json apps/api/
COPY apps/worker-web/package.json apps/worker-web/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile

# 从 build 阶段只拷贝运行产物,放回各自包目录(symlink 目标)
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/db/dist packages/db/dist/
COPY --from=build /app/packages/metrics/dist packages/metrics/dist/
COPY --from=build /app/packages/engine-adapters/dist packages/engine-adapters/dist/
COPY --from=build /app/packages/browser-session/dist packages/browser-session/dist/
COPY --from=build /app/packages/evidence/dist packages/evidence/dist/
# insight-agent 必须随镜像(漏拷导致运行时 MODULE_NOT_FOUND,worker CrashLoopBackOff 实测)
COPY --from=build /app/packages/insight-agent/dist packages/insight-agent/dist/
COPY --from=build /app/apps/api/dist apps/api/dist/
# insight-pdf.ts 运行时按 __dirname 向上两级读取字体(apps/api/assets/fonts),必须随镜像
COPY --from=build /app/apps/api/assets apps/api/assets/
COPY --from=build /app/apps/worker-web/dist apps/worker-web/dist/
COPY --from=build /app/apps/web/.next apps/web/.next/
COPY --from=build /app/apps/web/next.config.mjs apps/web/next.config.mjs
RUN rm -rf apps/web/.next/cache

# node:24-alpine 自带 uid 1000 的 node 用户
USER node
# 默认启动 API;web 与 worker 在 SAE 控制台/CLI 配置启动命令覆盖:
#   api:    node apps/api/dist/main.js
#   worker: node apps/worker-web/dist/main.js
#   web:    node apps/web/node_modules/.bin/next start -p 3001 (或 standalone 产物)
CMD ["node", "apps/api/dist/main.js"]
