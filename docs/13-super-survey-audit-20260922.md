# 超级问卷审查与验收记录

> 生产状态（2026-09-22）：超级问卷已上线；此文保留设计/阶段验收上下文，最新发布与功能边界见 [生产发布记录](./15-super-survey-production-release-20260922.md)。

> 后续状态：本记录保留初轮验收快照。Persona Hub 与真人校准现已实现，本地已配置真实模型；最新结果见 [扩展验收记录](./14-persona-calibration-acceptance.md)。

日期：2026-09-22。范围：现有超级问卷从新建、问卷生成/编辑、人群确认、后台执行，到报告与导出的完整流程。

本次完成可恢复的合成问卷闭环。验收使用真实 Nest API、真实 PostgreSQL、实际 SurveyWorker、生产构建的 Next.js 页面及 Chrome；外部模型使用本地 HTTP 测试服务。本地环境及平台设置均未配置真实模型凭证，因此没有宣称完成真实供应商质量或线上验收。本次未部署线上。

## 修复的故障

| 问题 | 原行为 | 当前行为与验证 |
| --- | --- | --- |
| 操作路由互相覆盖 | Express 将 `surveys:generate` 中的冒号当参数，后续保存/建池/运行可能进入生成接口 | 冒号按字面匹配；真实 HTTP 验证各操作、未知操作 404 |
| 问题编辑不落库 | UI 可编辑，作答仍使用旧题目 | 保存题型、选项、题目顺序和增删；刷新验证一致 |
| 生成失败重复建调研 | 创建与生成绑定，失败重试增加草稿 | 先保存独立草稿，生成在同一 ID 上重试 |
| 页面状态易丢失 | 向导仅存 React 状态、刷新失去进度 | 每份调研有独立工作台；已保存数据与执行进度来自数据库；离开未保存编辑有提醒 |
| 无品牌用户无法进入 | Shell 将问卷误判为品牌依赖页面 | 独立调研允许零品牌账号使用；浏览器覆盖 |
| 长请求/服务重启丢任务 | 在 HTTP 内串行执行 200–2000 次模型请求 | API 返回 202；PG 持久任务、每任务 3 路并发、15 秒心跳、3 分钟租约，重启可恢复 |
| 并发、取消与重复执行 | 同一调研可重复跑；停止后旧结果继续写入 | 行锁领取和 token 隔离；取消后迟到结果不可写入；测试并发领取与失效租约 |
| 部分失败无法补齐 | 只要有成功答案即标完成，重试可能全量执行 | 区分 completed/partial/failed；仅补跑缺失或失败样本；8 人失败 1 人后补跑共 9 次调用 |
| 人群选错或完成态被重置 | 多个池取首个，创建新池可重置状态 | 显式 active_pool_id；修改题目撤销确认；有作答后禁止改题/换人群 |
| 旧数据升级 | 实际作答人群可能与最新池不同；不完整结果误标完成 | 迁移优先保留产生答案的池，恢复其确认，修正部分完成状态并验证可补跑 |
| 输入缺少服务端约束 | 空白题目、重复选项、负数/小数配额可进入数据库 | 前后端共用校验；1–20 题、1–20 人群组、正整数样本且合计不超过 2000 |
| 报告统计错误 | 多选统计组合而不是各选项；不显示计划样本与缺失 | 按选项加权、人为分母；保留零选项；量表均值；显示有效 N/计划 N/完成率 |
| 默认报告与人群库不工作 | `Number(null)` 得到 0；人群库只显示第一份调研 | 报告默认选择有结果的调研；全部调研的人群可查看，区分当前与历史 |
| 能力声明超出实现 | 标成 Persona Hub 增强/校准 | 明示配额生成人物、未经真人校准；保留建议与最终配额记录 |
| 长问卷输出被截断的风险 | 所有任务共用 2000 输出 token | 生成问卷 4096；作答按题数分配 2048–8192；沿用配置超时；问卷提示词记录 s2 版本 |

## 当前交付

- `/surveys`：检索、状态概览、继续草稿、后台进度、报告入口。
- `/surveys/new`：独立或关联品牌调研，目标示例和草稿保存。
- `/surveys/:id`：题目编辑、人群配额、明确确认、执行计划、进度、取消、补跑。
- `/surveys/pools`：租户内全部人群方案、当前/历史筛选、配额来源。
- `/surveys/reports?surveyId=...`：单选/多选分布、量表分布及均值、五个人群维度对比、开放题原文检索、CSV/JSON 导出。CSV 对公式注入文本做转义，导出保留样本量和合成声明。
- 桌面 1440px 与移动端 390px 浏览器检查，无页面级横向溢出、无 JS 页面异常。

运行状态：`draft → generating → ready_selecting → queued → running → completed/partial/failed`；生成和执行均可取消。已有成功答案的调研只能补跑，不能改变问题或人群以免混淆口径。

后台是数据库持久任务，无新增 Redis 队列依赖。每个 worker 实例同时处理一个调研，每份调研最多 3 个并发人物；多实例用 `FOR UPDATE SKIP LOCKED` 领取，任务 token 限制迟到写入。状态提交与任务提交为同一事务。

## API

所有接口沿用 Bearer JWT 并校验账号归属。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/surveys` | 创建草稿 |
| GET | `/surveys` | 最近 200 份调研 |
| GET | `/surveys/:id` | 详情、当前人群、进度 |
| POST | `/surveys:generate` | 生成任务，202 |
| POST | `/surveys:questions` | 保存题目 |
| POST | `/surveys:pools` | 保存新的人群方案 |
| POST | `/surveys:pools:approve` | 确认当前方案 |
| POST | `/surveys:run` | 开始/补跑，202 |
| POST | `/surveys/:id/cancel` | 取消并保留已保存答案 |
| GET | `/surveys/:id/report?dimension=gender` | 报告，维度也支持 ageBand/cityTier/incomeBand/occupationGroup |
| GET | `/surveys/:id/pools` | 单调研人群方案 |
| GET | `/surveys-pools` | 租户最近 200 个人群方案 |

## 验收结果

相关包测试累计 **207 项通过**：API 44、Shared 32、InsightAgent 45、Worker 81、DB 3、Web 2。其中 API 包的 15 项问卷测试使用隔离 PostgreSQL schema 和真实迁移，覆盖生命周期、租户隔离、输入拒收、并发、重启恢复、取消、历史迁移与补跑。其余包包含既有测试，207 并非全为新增测试。

API/Worker 构建、Web 生产构建、Web 类型检查及修改范围 ESLint 均通过。历史迁移存在 0004/0011/0013 重号告警；本次 0015/0016 未增加重号，隔离数据库完整迁移成功。

可复跑命令（仓库根目录）：

```sh
pnpm --filter @geo/shared build
pnpm --filter @geo/db build
pnpm --filter @geo/insight-agent build
pnpm --filter @geo/api build
pnpm --filter @geo/worker-web build
pnpm --filter @geo/api test
pnpm --filter @geo/shared test
pnpm --filter @geo/insight-agent test
pnpm --filter @geo/worker-web test
pnpm --filter @geo/db test
pnpm --filter @geo/web test
pnpm --filter @geo/web typecheck
SURVEY_WEB_PRODUCTION=1 node apps/worker-web/scripts/surveys-browser-audit.mjs
```

浏览器脚本默认连接本地 Postgres `15432` 和 Redis `16379/14`，也支持 `E2E_DATABASE_URL` / `E2E_REDIS_URL`；API/Web 端口默认 `3210/3211`。脚本使用独立 schema、临时 Web 副本和随机测试 JWT，不读取 `.env`、不改变平台模型设置、不干扰现有 `.next` 目录；退出清理进程和测试 schema。机器需安装 Chrome，运行依赖已安装的 playwright-core。

本次证据：`/tmp/geo-surveys-audit-20260922/browser/`，包含 `result.json`、6 张桌面/移动截图、`report.csv`、生产构建日志与 API/Worker 日志。

## 使用与边界

启用时需要先执行 0015/0016 迁移，再启动包含 SurveyWorker 的 worker 和 API，并在平台全局配置中启用可用的 InsightAgent 模型。未配置时生成/运行返回清晰 503，手工编辑问卷仍可使用。外部模型每个人物独立调用，失败重试会增加额度消耗。

当前是合成研究工具，不能把合成样本数当真人统计置信度。Persona Hub 导入、条件人口分布映射、共享档案库、真人校准和开放题主题聚类仍属于 11/12 号文档的后续设计；本次没有伪造或声称这些能力已具备。开放题每题/每组最多展示和导出 200 份原文，数值分布基于全部有效样本。未进行 2000 人真实供应商负载/成本测试。

仓库开始时已有未提交改动；本次保留已有改动，不替换账号登录等无关工作。`scripts-dev/` 下已有一次性脚本会修改平台设置，不作为本次验收入口。
