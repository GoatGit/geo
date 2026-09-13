# 07 · 技术实施方案：Node.js + PostgreSQL + SAE + AgentBay Browser Use(CDP)

> 本文是 03/04/05 号文档的落地版。**v2 修订**：应用层(web/API/Worker)部署在阿里云 **SAE(Serverless 应用引擎)**；网页端采集的浏览器实例采用 **无影 AgentBay 的 Browser Use 镜像(`browser_latest`)**，通过 CDP 端点接入。v1 的"ECS + 自建 Chromium 容器池"方案废弃，保留为降级路径(§4.6)。与 03 文档冲突处以本文为准。
> 范围：网页端通道(P0)。APP 端通道(P1)预留接口，AgentBay 的云手机镜像届时评估。

## 1. 选型总览

| 层 | 选型 | 说明 |
|----|------|------|
| 语言/运行时 | TypeScript 5 + Node.js 22 LTS | 全栈同语言 |
| 前端 | Next.js 14 + TanStack Query + shadcn/ui + ECharts | 同 03 文档 |
| API/BFF | NestJS 单体(模块分包) | 用户/监测/指标/报告/账户/WS 网关 同进程起步 |
| 采集 Worker | Node.js 常驻进程(无状态)，`playwright-core` + `connectOverCDP` | Worker 本身不装浏览器 |
| 远程浏览器 | **AgentBay Browser Use 镜像 `browser_latest`**，会话制，CDP WebSocket 接入 | 见 §4 |
| 部署 | **SAE**：geo-web / geo-api / geo-worker 三个应用 | 免运维节点，指标弹性+定时弹性，支持 WebSocket(ALB/CLB) |
| 队列/调度 | BullMQ(Redis) | 每引擎一队列做令牌桶限流，重试强制换账号换出口 |
| 数据库 | 阿里云 RDS PostgreSQL 16/17 | 业务库 + 口径事实表，按月分区 |
| 缓存/锁/进度 | Tair/Redis | 配额原子计数、分布式锁、WS 广播 |
| 对象存储 | OSS | 证据包；WORM 合规保留 + 版本化 + 生命周期 |
| 账号态持久化 | **AgentBay Context / Browser Context**(Cookie/缓存/localStorage 跨会话) | 替代 v1 的"ESSD + user-data-dir"，见 §4.2 |
| LLM 解析 | 阿里云百炼/DashScope(轻模型)，VPC Endpoint 内网调用 | 抽取/拓写/分类 |
| 短信 | 阿里云短信(前置：域名 ICP 备案 + 签名模板报备) | 验证码登录 |
| 密钥/凭证 | KMS 信封加密(账号 Cookie/Token 落库密文) | 见 §10 |
| 日志/监控 | SLS + Prometheus 托管 + Grafana，告警到钉钉 | SAE 一键接入 |
| CI/CD | GitHub/GitLab → ACR → SAE 镜像部署(分批发布+健康检查) | 适配器热修只发 worker 应用 |

**关键决策与理由**：
1. **SAE 而非 ECS**：web/worker 均为无状态容器，SAE 免节点运维、按量计费(秒级)、staging 可缩到 0；worker 用"定时弹性"(白天重夜间轻，天然贴合 04 §3.4 的拟人化节奏)+ "自定义指标弹性"(队列深度，经 Prometheus)。
2. **AgentBay 而非自建浏览器池**：把浏览器基础设施(Chromium 运维、并发调度、沙箱隔离、版本升级)外包给阿里云，换取：无浏览器运维人力、秒级弹性、原生会话隔离；代价是固定权益包费用与指纹可控度略降(§4.1、§11 有对策)。
3. **MVP 不上 ACK**：SAE 已覆盖部署与弹性诉求。

## 2. 部署拓扑(阿里云)

```
                        公网(ALB/CLB) ──► SAE: geo-web (Next.js)
                              │
┌─────────────────── 用户 VPC ─────────────────────────────────────────┐
│  ┌────────────────────────┐        ┌───────────────────────────────┐ │
│  │ SAE: geo-api            │        │ SAE: geo-worker (×N 实例)      │ │
│  │ NestJS 单体 + WS 网关    │        │ BullMQ 消费 + 采集编排          │ │
│  │ 定时弹性/手动扩缩        │        │ 定时弹性(白天重)+指标弹性(队列) │ │
│  └───┬──────┬─────────┬───┘        └──────┬───────────────┬────────┘ │
│      │      │         │                   │               │          │
│  ┌───▼──┐ ┌─▼────┐ ┌──▼───────────┐       │ AgentBay      │ DashScope│
│  │ RDS  │ │Tair/ │ │ OSS(证据包)   │       │ OpenAPI/SDK   │ (VPC EP) │
│  │ PG   │ │Redis │ │ WORM+生命周期 │       │ (公网 TLS)     │          │
│  └──────┘ └──────┘ └──────────────┘       ▼               └──────────┘
└───────────────────────────────────────────┼────────────────────────────┘
                                            ▼
                     ┌──────────────────────────────────────────┐
                     │ 无影 AgentBay(阿里云托管,华东2-上海)        │
                     │  Session = browser_latest 镜像沙箱          │
                     │  ├─ Browser Context(账号态持久化)          │
                     │  ├─ BrowserOption(UA/视口/指纹/代理)       │
                     │  └─ CDP 端点(wss, token 鉴权)◄─connectOverCDP
                     │        └─ 出口:住宅代理(会话粘性)           │
                     └──────────────────────────────────────────┘
```

阿里云服务映射表：

| 用途 | 服务 | M0 规格 | M1 规格(54万 QueryRun/月) |
|------|------|---------|---------------------------|
| Web 前端 | SAE geo-web | 0.5vCPU/1G ×1 | 1vCPU/2G ×2 |
| API/WS | SAE geo-api | 1vCPU/2G ×1-2 | 2vCPU/4G ×2 |
| 采集 Worker | SAE geo-worker | 1vCPU/2G ×1-2 | 2vCPU/4G ×2-8(弹性) |
| 远程浏览器 | AgentBay Browser Use | **Pro 权益包**(CDP 端点前置条件，并发 200 会话) | Pro/Ultra |
| 业务库 | RDS PG 高可用 | 4C16G | 8C32G + 只读副本 |
| 队列/缓存 | Tair/Redis 主从 | 2G | 8G |
| 证据包 | OSS + WORM + 生命周期 | ~100G | ~1T(录屏 7 天滚动) |
| 日志/监控/链路 | SLS / Prometheus / ARMS | 按量 | 按量 |

> 区域统一**华东2(上海)**：AgentBay SDK 默认连上海区域，SAE/RDS/Redis 同区域部署，降低 CDP wss 链路 RTT。若延迟不达标，AgentBay 提供 GetLink 加速通道(额外计费)作为后备。

## 3. SAE 应用拆分与弹性策略

| 应用 | 形态 | 弹性 |
|------|------|------|
| geo-web | Next.js 容器 | CPU 弹性；夜间可缩最小实例 |
| geo-api | NestJS 容器(含 WS 网关) | CPU/QPS 弹性；WS 长连接经绑定的 ALB/CLB(PoC 项：验证 WS 空闲超时配置) |
| geo-worker | BullMQ 消费进程容器 | **双层弹性**：①定时弹性(按地域时区白天扩、夜间缩，呼应 04 §3.4 拟人化总量分布)；②自定义指标弹性(队列深度/积压时长，经 Prometheus → SAE 指标伸缩。PoC 项：验证自定义指标链路，兜底用 CPU 弹性) |

- 三个应用同属一个 SAE 应用列表，共享 VPC/安全组；**staging 环境最小实例数设 0**(SAE 支持缩零)，省成本。
- 适配器热修(页面改版响应)只重新部署 geo-worker + `packages/engine-adapters`，web/api 不动；SAE 分批发布 + 健康检查保证滚动无感。
- 报告 PDF 渲染、历史重放等批处理可选用 **SAE 任务(Job)** 跑完即释放，不占常驻实例。

## 4. AgentBay 浏览器池设计(核心)

### 4.1 镜像选型(结论：`browser_latest`)

AgentBay 提供四大环境(浏览器/云电脑/代码空间/云手机)与对应镜像，逐一评估：

| 镜像 | 用途 | 适配本产品？ |
|------|------|-------------|
| **`browser_latest`(Browser Use 系统镜像)** | 预装 Chromium 的云浏览器，支持 `BrowserOption`(user_agent/viewport/stealth/proxy/fingerprint)与 `session.browser.get_endpoint_url()` 返回 **CDP WebSocket 端点**，官方示例即 Playwright `connect_over_cdp` | ✅ **网页端通道采用** |
| `code_latest`(代码空间) | 代码沙箱，跑脚本/计算 | ❌ 无浏览器自动化语义 |
| Windows/Linux 系统镜像 / 自定义镜像(Pro/Ultra，最多 50 个、同时启用 5 个) | 完整云电脑，可装任意软件 | ❌ 过重、按桌面时长计费不经济。**保留用途**：若需锁定 Chromium 版本做指纹稳定，可定制带固定版本浏览器的自定义镜像(指纹漂移的兜底手段) |
| 云手机镜像 | Android 云手机 | ⏸ P1 **APP 端通道**的首选评估对象(替代 v1 方案的"云真机农场") |

> 注意(来自官方文档)：`get_endpoint_url()` 需订阅**高级权益包**(Pro ¥999/月 或 Ultra ¥1499/月；Basic 免费包并发上限 10 会话)。CDP 端点是我们的架构前提，权益包费用已计入 §12 成本。镜像实时清单以控制台"镜像管理"或 `agentbay image list` 为准，PoC 时确认版本号并记录进 `meta.json`。

### 4.2 会话模型：临时会话 + Context 持久化 + 账号三元组

AgentBay 会话是**秒级创建、用完即毁**的 Serverless 沙箱(v1 的"常驻容器"模型不再适用)。账号态一致性改由三层保证：

```
账号 AccountProfile
  ├─ AgentBay Browser Context   ← Cookie/缓存/localStorage 跨会话持久化(官方 Context 机制)
  ├─ BrowserOption 指纹参数      ← UA/视口/语言/指纹选项,按账号档案固定注入
  └─ 住宅代理(会话粘性)         ← BrowserOption proxy 注入,同账号固定出口段
```

- **登录态**：账号登录一次后，浏览器状态存入该账号专属的 Browser Context；后续会话挂载同一 Context 即免登录。Context 的同步时机与 API 细节(`browser-context` 文档)在 PoC 中确认(预期：会话结束时同步回存)。
- **指纹一致性**：账号档案 `{UA, 视口, 时区, 语言}` 存 PG，每次 `BrowserOption` 注入同一套值；指纹由"Context 持久化 + 参数固定 + 出口粘性"三者共同保证，可控度略低于自建浏览器，但对"同一账号看起来是同一个人"这个目标足够(竞品实测证明该档位的拟人化即可用)。
- **并发与配额内化不变**：单账号每引擎每日提问上限(如 20 次)、同品牌跨账号打散等规则仍在编排器执行，AgentBay 只是执行环境。
- **会话绑定批次**：一次会话承载**一个账号的一批查询**(如该账号名下 5 个引擎的 Tab 并行跑 10 个问题)，跑完即毁——把每查询的会话成本摊薄，见 §4.4。

### 4.3 CDP 接入与采集双路线

```ts
// packages/browser-session
const session = await agentBay.create({ imageId: 'browser_latest',
                                        contextId: profile.contextId });   // 账号态
await session.browser.initialize(new BrowserOption({
  userAgent: profile.ua, viewport: profile.viewport,
  proxy: profile.residentialProxy,      // 语法以 PoC 实测为准(文档确认支持 proxy)
}));
const cdpUrl = await session.browser.getEndpointUrl();                     // wss + token
const browser = await chromium.connectOverCDP(cdpUrl);                     // playwright-core
```

- **路线 B(优先)**：CDP `Network` 域截获引擎对话接口的 SSE 流——结构化正文+引用卡片，抗改版；
- **路线 A(兜底)**：DOM 抽取 + 三条件完成判定(流停止 + DOM 稳定 3s + 停止控件消失)，同 04 文档；
- 拟人输入(`keyboard.type` 逐字抖动)、引用卡抓取、竞品发现等逻辑全部不变——**引擎适配器层对"浏览器在哪"无感**，这是 AgentBay 化改造成本低的原因。

### 4.4 会话生命周期与并发预算

| 参数 | 取值(初值，PoC 校准) | 说明 |
|------|----------------------|------|
| 单会话承载 | 1 账号 × ≤5 引擎 Tab × ≤10 问题 | 串行人机节奏，单会话 15-40 分钟 |
| 并发会话数 | M0 ≤10(Basic 并发上限)→ Pro 后 ≤200 | M1 峰值预算 ≈ 40-80 会话 |
| 冷启动 | 秒级(官方口径)；预算 5-15s/会话 | 首轮出数 SLA(≤10min)仍宽裕 |
| 会话保活 | 无——用完即毁 | 避免闲置积分燃烧；跨轮次不保活 |
| 失败处理 | wss 断连/沙箱异常 → 本次 run `failed` → 重试换账号(新会话新 Context) | 同 04 §5 |

**单会话积分成本模型**(官方计费：Browser Use 0.5 积分/小时，积分包 ¥1.2/积分 → **≈¥0.6/会话小时**；不足 1 小时按秒计)：
- 保守按 30 查询/会话小时(含人机节奏与引擎等待)→ **≈¥0.02/查询**；
- 按 5 Tab 并行提效到 60-90 查询/会话小时 → **≈¥0.007-0.01/查询**；
- 对比 v1 自建方案的计算资源(¥0.02-0.05/查询)：**单位成本更低或持平，且零浏览器运维**；代价是固定 ¥999-1499/月权益包。PoC 用真实数据校准"查询/会话小时"这个关键比率。

### 4.5 存证(不变项 + 新增项)

- 证据包结构不变:`answer.json / raw.mhtml / screen.mp4 / meta.json / integrity.sha256` → OSS WORM；
- 录屏仍用 **CDP `Page.startScreencast` 截帧 → ffmpeg**(Playwright `recordVideo` over CDP 不可用)；AgentBay 自带"会话录制/ASP 实时可视化"仅作排障与内部审计补充，**不作为证据链来源**(证据必须自有哈希链)；
- `meta.json` 新增:`agentbay_image_id`(browser_latest + 版本号)、`context_id 指纹`、`session_id`，保证历史数据可解释(镜像升级=指纹变更事件)。

### 4.6 备选与降级路径

`packages/browser-session` 对上暴露统一接口(`acquire(profile) → cdpUrl`, `release`)。若 AgentBay 出现下列情况，可整体替换实现而不动引擎适配器：
- 权益包/积分费率大幅调整；
- CDP 端点能力受限(如禁止 Network 域抓包)；
- 大规模风控失败归因到沙箱指纹。
降级实现即 v1 方案：ECS + 自建 Chromium 容器池(设计存档于 git 历史 v1 版本文档)。**采集能力不绑定单一供应商**是架构红线。

## 5. Monorepo 结构(pnpm workspace)

```
geo/
├─ apps/
│  ├─ api/                 # NestJS 单体：用户/监测/指标/报告/账户/WS 网关   → SAE geo-api
│  ├─ worker-web/          # 网页端采集 Worker(BullMQ 消费)                → SAE geo-worker
│  └─ web/                 # Next.js 控制台                                → SAE geo-web
├─ packages/
│  ├─ engine-adapters/     # 引擎适配器(schemaVersion;dev 走 Mock 回放)
│  ├─ browser-session/     # AgentBay 会话代理:创建/CDP 端点/Context 绑定/代理注入/降级实现
│  ├─ evidence/            # 证据包构建(OSS 上传、sha256 清单、WORM)
│  ├─ metrics/             # 口径计算(02 文档唯一出口)
│  └─ shared/              # 类型、四态状态机、口径常量
└─ infra/                  # SAE 应用声明、镜像 Dockerfile、RDS 迁移 SQL、告警规则
```

SDK:`npm install wuying-agentbay-sdk`(TypeScript 官方 SDK，Node ≥14);Worker 进程内 I/O 密集即可管理多会话,1vCPU/2G 起步。

## 6. 单条 QueryRun 时序

```
Orchestrator(BullMQ, queue=engine:doubao, job=runId)
  → Worker 领取 → SessionManager 取账号档案(Context+指纹+代理三元组)
  → [会话不存在] agentBay.create(browser_latest, contextId) → BrowserOption 注入 → getEndpointUrl
  → connectOverCDP → 校验登录态(Context 免登录;失效则走账号池换绑)
  → 打开引擎页 → 拟人输入 → Network/DOM 捕获回答 → 完成判定
  → 证据包落 OSS(answer/mhtml/截帧 mp4/meta+sha256)
  → QueryRun 状态回写(四态) + Redis pub/sub → WS 推前端队列面板
  → 即时抽取(<2s) → 口径事实表 → 指标服务
  → [该账号批次完成] 会话销毁(Context 已回存登录态)
```

## 7. 队列、限流与重试(BullMQ)

- **每引擎一条队列**,`limiter:{max,duration}` 引擎令牌桶;验证码率突增由编排器动态调小(Redis 热读)；
- 优先级：快速体检 > 专业 > 标准 > 入门 > 免费(`jobPriority` + 分级队列)；
- **重试**：指数退避最多 2 次，必须换账号(=换 Context+出口+指纹)再开会话；
- `quota_blocked` 不入队,`failed` Worker 上报——**失败永不静默变 0**。

## 8. 数据库设计(RDS PostgreSQL)

对 05 号文档的两处修正(已定稿)：
1. `mention_facts` 冗余 `ran_at/engine/surface/question_id`,实时聚合不回连、分区裁剪依赖 `ran_at`；
2. `citation_facts`/`reputation_facts` 补 `parser_version`(全部事实表可重放)。

```sql
CREATE TABLE query_runs (
  id bigserial, brand_id bigint, question_id bigint, engine text, surface text,
  round_id bigint, status text CHECK (status IN
    ('ok_with_answer','ok_empty','failed','quota_blocked')),
  adapter_version text, account_fingerprint text, egress_ip inet,
  ran_at timestamptz NOT NULL,
  answer_ref text, snapshot_ref text, recording_ref text,
  evidence_hash text, meta jsonb,          -- meta 含 agentbay image/session 信息
  PRIMARY KEY (id, ran_at)
) PARTITION BY RANGE (ran_at);             -- 每月一分区,定时预建

CREATE TABLE mention_facts (
  id bigserial, run_id bigint, brand_id bigint,
  subject_kind text, subject_id bigint,
  mentioned boolean, rank int, co_ranked boolean default false,
  ran_at timestamptz NOT NULL, engine text, surface text, question_id bigint,
  evidence jsonb, parser_version text, confidence real,
  PRIMARY KEY (id, ran_at)
) PARTITION BY RANGE (ran_at);
CREATE INDEX ON mention_facts (brand_id, ran_at, engine);
-- citation_facts / reputation_facts 同样按 ran_at 分区,均带 parser_version
-- credit_ledger 只追加;agentbay_points_ledger 记录权益包与积分消耗,进成本分摊
```

聚合策略：实时层直查事实表(brand_id+ran_at+engine 索引)；日结 `daily_metrics` cron 生成；M1 聚合查询走 RDS 只读副本；连接经 **RDS 数据库代理**托管，避免 Worker 多实例打爆连接数。

## 9. OSS 证据包与留存

同 v1:`evidence/{runId}/` 五件套 → OSS,WORM 合规保留策略(写入即只读)，录屏前缀 7 天生命周期，answer/meta 12 个月；访问走 STS 签名 URL；报告引用的证据随报告 payload 归档(解 7 天保留 vs 验收链冲突)。

## 10. 安全与合规

| 项 | 方案 |
|----|------|
| CDP 链路 | AgentBay 端点为 **wss + token 鉴权、仅出站连接**——相比 v1 自建(需自管 VPC 隔离与反代鉴权)，暴露面更小；token 经 KMS 管理，不落日志 |
| 账号凭证 | Cookie/Token KMS 信封加密落库；AgentBay Context 中仅存浏览器态(免登录 Cookie)，与用户账号体系隔离；日志全链路脱敏(账号指纹只存哈希) |
| 数据边界 | 采集目标页内容流经阿里云 AgentBay 沙箱与 OSS(同云内)，不落第三方；对外分享报告脱敏账号信息 |
| 网络 | RDS/Redis/OSS/DashScope 全 VPC Endpoint;Worker→AgentBay 走公网 TLS(API 域名白名单)；代理出口仅住宅段 |
| 应用 | JWT+RBAC；brand_id 数据层强制作用域；短信双频控 |
| 合规 | ICP 备案(短信前置)；PIPL 告知同意/注销删除;《AI 生成合成内容标识办法》对外分享标识评估；采集侧按 06 §4.1 法务白名单闸门 |

## 11. 可观测性与告警

- **Prometheus**：各引擎成功率、验证码率、会话创建失败率、CDP 断连率、队列深度与积压、**AgentBay 会话小时/积分消耗速率**(成本哨兵)、账号池健康分分布；
- **告警→钉钉**：引擎 5 分钟失败率>30%(联动熔断)、会话创建连续失败、积分消耗速率异常(防会话泄漏燃烧)、队列 P95 超 SLA、账号封禁突增；
- **Tracing**：OpenTelemetry → ARMS,runId 贯穿 编排→Worker→AgentBay 会话→抽取；
- SAE 应用日志直采 SLS，按 runId 串联;`meta.json` 记录镜像版本+适配器版本。

## 12. 容量与成本(阿里云量级)

| 项 | M0(≤50 品牌) | M1(54万 QueryRun/月) | 备注 |
|----|---------------|----------------------|------|
| SAE 三应用 | ¥0.3k-0.8k | ¥1k-2k | 按量/资源包；staging 缩零 |
| AgentBay 权益包 | **¥999(Pro)** | ¥999-1499(Pro/Ultra) | CDP 端点前置;并发 200 会话 |
| AgentBay 会话积分 | ¥0.1k-0.3k | **¥4k-8k** | ≈¥0.6/会话小时；按 30-90 查询/会话小时 |
| RDS PG | ¥0.5k-1.8k | ¥1.5k-3k(+只读) | |
| Tair/Redis | ¥0.2k | ¥0.4k-0.8k | |
| OSS/SLS/ARMS/ALB | ¥0.3k-0.5k | ¥0.8k-1.5k | |
| **云侧合计** | **≈ ¥2.4k-4.6k/月** | **≈ ¥9k-17k/月** | 不含住宅代理/账号供给/LLM |

对比 v1(ECS 自建)：单位查询的浏览器成本从 ¥0.02-0.05 降到 **¥0.007-0.02**，省掉采集节点运维人力；固定费换可变费，M0 总成本接近、M1 持平略优。**2026-09 定价决策**：专业版已取消"每日 2 轮"（全档位每日 1 轮），标准/专业档毛利偏薄的问题按 06 §3 的三项假设（使用率 60%、免费转化率 ≥8%、封损率 ≤15%）跟踪，失守即复审定价。

## 13. M0 落地清单(10 周)

| 周 | 交付 |
|----|------|
| W1-2 | Monorepo 骨架；开通 SAE×3 / RDS / Tair / OSS / KMS；**AgentBay PoC**：订阅 Pro → `browser_latest` 会话 → `getEndpointUrl` → `connectOverCDP` 打通 1 引擎；验证 BrowserOption 代理/指纹语法、Context 跨会话登录态、CDP Network 域抓包可行性、会话冷启动耗时；产出"查询/会话小时"实测值 |
| W3-4 | 引擎适配器 ×2(network-capture 路线 + dom 路线) + Mock 回放测试集；四态状态机；CDP 截帧→ffmpeg 录屏 → OSS WORM |
| W5-6 | 账号池(Context 绑定、健康分、KMS 加密)；住宅代理粘性；BullMQ 编排/限流/重试/熔断；SAE 定时弹性+指标弹性调试 |
| W7-8 | WS 进度面板；排名透视(指标卡/榜单/矩阵/口径徽章)；快照存证页 |
| W9-10 | 免费版+入门版订阅、短信登录(前置 ICP 备案)；压测(40 QueryRun ≤10min、成功率 ≥95%)；告警接入；积分消耗哨兵；安全自查 + 法务白名单收口 |

**PoC 必须验证的 6 个风险点**(任一不成立即触发 §4.6 降级评估)：
1. `browser_latest` 会话内 CDP Network 域可完整截获引擎 SSE 流；
2. BrowserOption 支持自定义住宅代理且代理链路稳定；
3. Browser Context 能跨会话保持引擎登录态(≥7 天有效)；
4. `getEndpointUrl` 对 Playwright `connectOverCDP` 完全兼容(含多 Tab)；
5. 会话冷启动 ≤15s、单会话小时查询吞吐 ≥30；
6. Basic 包是否已含 CDP 端点(若含，M0 可先省 ¥999/月)。

## 14. 风险速查

| 风险 | 对策 |
|------|------|
| AgentBay 能力/费率变更 | §4.6 统一 SessionBroker 抽象，自建 Chromium 池为降级实现；权益包与积分消耗进周报 |
| Playwright recordVideo 不支持 over CDP | `Page.startScreencast` 截帧 → ffmpeg(已入设计) |
| 镜像升级导致指纹漂移 | `meta.json` 记录镜像版本；必要时 Pro/Ultra 自定义镜像锁 Chromium 版本 |
| 会话泄漏(未销毁)燃烧积分 | Worker finally 强制 release + 会话最长存活兜底 + 积分消耗速率告警 |
| 冷启动影响首轮出数 SLA | 会话按"账号批次"聚合，40 QueryRun 轮次仅需 8-10 会话；冷启动 5-15s 可忽略 |
| 页面/接口改版 | 路线 B 接口捕获抗性强；适配器 schemaVersion + Mock 回放 + 2 人专项热修(只发 geo-worker) |
| Context 登录态意外失效 | 账号池健康分体系接管网页登录(验证码/扫码由运营处理)，换绑后继续 |
| CDP 公网链路抖动 | 同区域(上海)部署；GetLink 加速兜底；断连自动重开会话重试 |
