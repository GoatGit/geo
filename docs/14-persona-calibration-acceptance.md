# Persona Hub 与真人校准验收

> 生产状态（2026-09-22）：超级问卷已上线；此文保留设计/阶段验收上下文，最新发布与功能边界见 [生产发布记录](./15-super-survey-production-release-20260922.md)。

2026-09-22，本次按要求完成三项：子菜单收敛、本地真实模型配置、Persona Hub 与真人数据校准接入。未部署线上。

## 使用入口

“超级问卷”仅保留 **问卷、人群库、调研报告**。新建按钮在问卷页，`/surveys/new` 页面继续可用。

人群库包含共享人物档案和调研人群方案。管理员可导入官方数据并按批次进行模型结构化增强；普通用户可检索已导入档案，在选择调研人群时使用“仅 Persona Hub”或“优先 Persona Hub，缺口生成”。每份调研保留来源档案快照，后续增强和原文更新不会改写历史作答。

调研报告底部新增“真人数据校准”。可以填写真人调查元数据及选项占比，或导入 UTF-8 CSV：列名为问卷题目 ID，每行一个受访者，单元格是选项原文/量表分值。当前支持 1–10 道单选或 1–10 分量表题；多选和开放题不能作为互斥边际分布进行此类校准。CSV 在浏览器计算匿名汇总，姓名、邮箱等其他列不上传。对选定问题，缺失/非法答案会被拒收。

元数据包括名称、来源、目标人群、真人有效 N、调查/发布日。不能将 AI 回答当作真人基准。通过校验并达标后，系统更新本次人群权重，重新计算所有题目的加权报告；保留原始答案与历次校准。失败不覆盖之前已应用的权重。部分结果再次补跑会撤销旧校准，避免把旧权重混用于新样本。

## 真实模型与实测数据

本地 PostgreSQL 平台配置及 git 忽略的 `.env` 已配置项目现用的 `glm-5.3-flash`（OpenAI 兼容协议）；60 秒超时。密钥未写入源码/报告/终端输出。数据库配置优先，`.env` 作为配置清空后的本地引导。`pnpm dev:worker` 现会读取根目录 `.env`，避免使用错误的默认数据库地址。

- 连通性测试：成功，约 2.15 秒。
- 真实问卷生成：成功返回 8 道题、5 组人群建议，版本 `insight@p1+openai/glm-5.3-flash+survey-s2`。
- Persona Hub：官方 200,000 条 preview 全部入本地共享库；首批 20 条真实模型增强，12 条通过校验，8 条保持失败可重试。未对全部 20 万条发起收费模型调用。
- 真实作答：24 份完成，两道与公开调查一致的题目，每个人物独立调用真实模型。
- 真人基准：FiveThirtyEight 2014 Star Wars 调查原始 1,186 行；两道题完整作答的 1,068 行构成同一组 complete cases。公开数据 CC-BY-4.0，来源和聚合 fixture 已保存。日期记录来源发布日期，非独立核实的访谈日期。

| 基准题 | 真人 Yes 占比 | 合成原始 Yes 占比 | 校准后 Yes 占比 | 最大偏差变化 |
| --- | ---: | ---: | ---: | ---: |
| 是否看过 Star Wars I–VI 任一电影 | 77.5281% | 91.6667% | 77.7746% | 14.1386 → 0.2465 个百分点 |
| 是否认为自己是 Star Trek 粉丝 | 39.9813% | 8.3333% | 39.9813% | 31.6479 → 约 0 个百分点 |

加权有效样本量 ESS 为 **8.95 / 24**。这是用于验证算法和数据流的美国公开调查演示，不用于验证中国消费品研究人群，也不能把校准后的拟合误差当独立测试准确率。真实测试保留在本地专用测试账号下，survey ID=21。

机器可读证据：
- [真实模型、作答和校准结果](./evidence/super-survey-20260922/live-result.json)
- [连通性结果](./evidence/super-survey-20260922/model-test.json)
- [公开真人基准及题目](./fixtures/star-wars-human-benchmark.json)
- 本机截图/浏览器日志：`/tmp/geo-persona-20260922/browser/`。

## 校准方法与状态

采用迭代比例加权（raking），每轮投影到有界权重范围，平均权重保持 1。最大 200 次迭代，单人权重 0.05–20；最大选项绝对偏差 ≤2 个百分点且 ESS ≥合成有效 N 的 20%（至少 5）才标记通过。缺乏某个真人选项的合成样本、冲突边际、过低 ESS 均会失败，不凭空补造回答。

输入真人基准是人工声明的数据来源，不自动替用户认证数据真伪。页面显示来源、目标人群、真人/合成 N、ESS、校准前后分布、失败原因。共享 Persona Hub 档案没有全局“已校准”标签，因为权重依赖具体问卷、具体目标人群和基准。

## Persona Hub 来源、许可与恢复

官方仓库：<https://github.com/tencent-ailab/persona-hub>。固定 revision：`72bf19b886312041b32f7cae12c02dab8653c6fa`。导入文件：`data/persona.jsonl`，21,625,636 字节；官方 Git blob SHA-1：`43ec406a7df5c881bfc1723334cf566a4ded2aaa`。

本地镜像存于 `infra/local-data/persona-hub/persona.jsonl`（git 忽略），通过 `PERSONA_HUB_DATA_FILE` 配置。Worker 导入前验证 Git blob 哈希，损坏/非固定版本文件拒收。无镜像时仅从固定官方 URL 下载，禁止任意 URL 和重定向。数据逐行解析、分批入库、按内容哈希去重；持久任务、心跳租约和 token 隔离支持重启续跑。增强按批次限额执行，未通过字段/置信度完整性校验的档案不能参与抽样。置信度是模型自报，不等同人工标注准确率。

官方 README 的数据许可明确是 **CC-BY-NC-SA-4.0**，代码才是 MIT。本地研究接入已实现；生产导入、增强和抽样默认关闭，只有确已取得商业授权并设置 `PERSONA_HUB_COMMERCIAL_LICENSE_REF` 才启用。该配置不是获取授权的替代品。本次未取得或声称取得商业授权。

匹配优先遵守档案中已知人口属性；缺失值按用户明确选择的配额赋值，并在快照记录 `assignedDimensions`。未编造 CFPS/统计局条件分布或“校准人口代表性”。有放回抽样时保留不同来源档案数并提示重复来源。

## 接口与数据库

迁移 `0017_persona_library_calibration.sql` 新增共享档案、导入任务、校准记录表，并为池和样本增加来源/校准引用。已有数据默认使用生成来源、未校准权重。

| 接口 | 权限 / 用途 |
| --- | --- |
| GET `/persona-library?q=&offset=` | 已登录用户：检索、计数、导入进度 |
| POST `/persona-library/imports` | 管理员：`{count: 1..200000}`，返回 202 |
| POST `/persona-library/enrich` | 管理员：`{count: 1..500}`，返回 202 |
| POST `/surveys/:id/pools` | 所属租户：segments + sourceMode（generated/hybrid/persona_hub） |
| GET `/surveys/:id/calibrations` | 所属租户：最近 20 条校准历史 |
| POST `/surveys/:id/calibrations` | 所属租户：真人基准与有界权重计算/应用 |

问卷操作路径统一使用 `/surveys/:id/generate`、`/questions`、`/pools/:poolId/approve`、`/run`，不再依赖冒号动作路径。

## 验证与本地运行

相关包累计 **222 项测试通过**（包含原有测试）：Shared 37、API 53、InsightAgent 46、Worker 81、DB 3、Web 2。API 与 Worker 类型构建、Web 生产构建、修改范围 ESLint 均通过。新增用真实隔离数据库验证导入幂等、坏文件、增强领取、来源快照、严格/混合抽样、校准应用、失败保留旧权重和租户隔离。Chrome 生产构建验收覆盖管理员权限、Persona Hub 抽样、真人 CSV 校准、导出和手机端。

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
pnpm --filter @geo/web test
SURVEY_WEB_PRODUCTION=1 node apps/worker-web/scripts/surveys-browser-audit.mjs
```

本机端口 3000 被另一个项目占用，可分别运行以下三个终端。API 与 Worker 从根目录 `.env` 获取本地真实模型/数据库配置，Web 的 API_ORIGIN 必须指向同一 API：

```sh
PORT=3300 pnpm dev:api
pnpm dev:worker
API_ORIGIN=http://localhost:3300 pnpm --filter @geo/web exec next dev -p 3301
```

避免与已有 Next 开发服务器同时使用同一 `.next` 目录。浏览器验收脚本自动使用独立临时副本与 schema，不修改本地模型配置；不使用会清空平台配置的 `scripts-dev/configure-insight.js` 作为验收前置步骤。
