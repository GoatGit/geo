# GeoLens · GEO 品牌监测平台(AI 搜索品牌可见性监测)

> 当用户问 AI 时,你的品牌被推荐了吗、排第几、AI 引用了谁 —— 用可回溯的证据链回答每一个数字。

设计文档见 [docs/README.md](./docs/README.md)(产品/口径/架构/采集/管道/路线图)。

## 代码结构(pnpm monorepo,TypeScript 全栈)

```
packages/
  shared/          领域类型、四态状态机、套餐门控、阈值/规则集常量(docs/02 代码化)
  db/              PostgreSQL schema(Drizzle)+ SQL 迁移(分区表)+ 迁移器/分区维护
  metrics/         口径引擎:列表抽取/识别口径匹配/综合名次/漏斗/健康/分层/行动规则/印象词/引用归一
  engine-adapters/ 引擎适配器接口 + 版本化注册表 + Mock 回放(dev/CI 全链路)
  browser-session/ SessionBroker:AgentBay Browser Use(生产)/ Mock(dev)
  evidence/        证据包(answer/raw/meta/integrity.sha256)+ S3 兼容存储(MinIO/OSS)
apps/
  api/             NestJS:auth/brands/questions/recognition/monitor(指标唯一出口)/runs/_collection/account/reports/WS
  worker-web/      采集编排:BullMQ 调度/熔断/账号池(健康分)/即时抽取/竞品发现/口碑基线/报告生成
  web/             Next.js 控制台:总览/排名透视(矩阵+漏斗)/引用源/口碑/问题/口径/采集状态/报告
```

## 本地开发

```bash
docker compose up -d          # PostgreSQL 16 + Redis 7 + MinIO
cp .env.example .env
pnpm install
pnpm db:migrate               # 迁移 + 分区预建
pnpm --filter @geo/worker-web seed:profiles   # dev:每引擎 2 个模拟账号档案
pnpm --filter @geo/worker-web seed:mock       # dev:21 天 mock 历史数据(事实/证据/日结/报告,幂等可重灌)

pnpm dev:api &                # API      http://localhost:3000
pnpm dev:worker &             # 采集 worker(mock 引擎回放)
pnpm dev:web                  # 控制台   http://localhost:3001
```

全链路(浏览器):登录(dev 验证码直接显示)→ 新建品牌 → 添加监控问题 →
worker 调度采集(mock 回放 5 引擎)→ 排名透视/漏斗/口碑/引用出数 → 报告生成。

## 测试与质量

```bash
pnpm test      # 构建全部包 + 单测(口径引擎 46 测为核心:综合名次 N+1 中位数、
               # 嵌套转化漏斗、四态分母规则、行动规则集 2026.09.1 等)
pnpm lint && pnpm typecheck && pnpm -r build
```

## 生产部署(阿里云 SAE + AgentBay)

见 [infra/sae/README.md](./infra/sae/README.md)。要点:三应用同镜像异启动命令;
`BROWSER_MODE=agentbay` 前必须通过 docs/07 §13 的 6 项 PoC 闸门,否则保持 mock 并评估自建降级路径。
