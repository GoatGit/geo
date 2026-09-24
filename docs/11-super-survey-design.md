# 超级问卷（Super Survey）功能设计 — 最快落地版

> 生产状态（2026-09-22）：超级问卷已上线；此文保留设计/阶段验收上下文，最新发布与功能边界见 [生产发布记录](./15-super-survey-production-release-20260922.md)。

> 实现状态（2026-09-22 更新）：问卷闭环、持久任务、Persona Hub 固定版本导入/结构化增强/配额抽样，以及带来源与偏差记录的真人基准加权校准均已实现。子菜单收敛为「问卷、人群库、调研报告」。本地真实模型和真人数据验收见 [扩展验收记录](./14-persona-calibration-acceptance.md)。原设计中的人口统计条件分布表与开放题主题聚类不应与当前的用户配额赋值、原文检索混淆。

> 2026-09-21 ｜ 目标：最小改动复用现有架构，跑通「LLM 生成问卷 → 虚拟人群作答 → 用户选人群 → 结构化报告」闭环
> 2026-09-21 更新：已确认引入 Persona Hub，人群库采用「结构化增强 → 映射入格 → 配额重采样 → 真人数据校准」四步流水线；并确定一级菜单信息架构（见 §8）

## 结论先行

最快路径是**把虚拟人群问卷做成"合成研究辅助工具"**，不宣称替代真人调研（上一轮调研的硬结论：合成样本分布不可信、只能做探索/预筛选）。技术上不引入 AgentSociety/OASIS 等重型仿真框架，首版用 **persona 档案 + prompt 条件化回答**（TinyTroupe/EDSL 的核心思路），一个 LLM 端点跑两类任务即可。

## 一、用户流程（4 步）

1. **发起**：用户选品牌 + 输入调研目标（一句话，如"测试新 SUV 定价 25 万的接受度"）。
2. **AI 生成问卷（可编辑）**：LLM 产出 5–10 题（单选/多选/量表/开放题）+ AI 建议的目标人群画像。
3. **用户选人群（最终决策权）**：系统给出人群候选卡片（如"一线 25–35 岁新能源意向者 N=500"），用户可增删维度、调样本量、否决 AI 建议。
4. **运行 + 报告**：虚拟人群逐 persona 作答 → 聚合为分布/交叉分析 + 置信提示，报告显式标注「合成样本」。

## 二、架构（复用现有件）

```
apps/api/src/surveys/            新模块（NestJS，照抄 brands/questions 结构）
  surveys.controller.ts          CRUD + 触发运行
  surveys.service.ts             编排：生成→人群→作答→聚合
packages/db/src/schema.ts        新表（见下）
packages/insight-agent/src/      新增两个 task（复用 chatCompletion/validate 模式）
  prompts.ts:  buildSurveyGenPrompt / buildPersonaAnswerPrompt
  schema.ts:   validateSurveyOutput / validatePersonaAnswerOutput
apps/web/src/app/...             新页面：向导式 4 步流程
```

**不引入新依赖**：Persona 生成用 LLM + 结构化 JSON，不用 Persona Hub 数据集（许可未核验，且自建更可控）。不引入多智能体仿真引擎——产品问卷是独立作答，不需要社会动态。

## 三、数据模型（最小 4 张表）

| 表 | 关键字段 |
|---|---|
| `surveys` | id, brand_id, objective, status(draft/generating/ready/completed), questions_jsonb |
| `persona_pools` | id, survey_id, created_by_user, spec_jsonb(维度+配额), size, approved(bool ← 用户决策) |
| `personas` | id, pool_id, profile_jsonb(年龄/职业/性格/消费观等) |
| `survey_responses` | id, persona_id, answers_jsonb, model, parser_version(复用 insightParserVersion 模式) |

配额抽样在生成 personas 时按 `spec_jsonb` 的比例分配维度组合，避免纯随机拼接敏感属性（调研发现的偏见风险）。

## 四、LLM 任务设计（两个结构化任务，走 insight-agent 通道）

1. **survey_gen**：输入目标 + 品牌上下文 → 输出 `{questions[], persona_spec_suggestion[]}`；用户可改每一项，修改后重新校验 JSON。
2. **persona_answer**：输入单个 persona profile + 全部问题 → 输出 `{answers[]}`；**逐 persona 调用**（不批量塞同一 prompt，保证独立性），并发受现有 worker 限流约束。成本可控：500 persona × 8 题约一次调用/persona，用便宜模型（env 已有 INSIGHT_AGENT 配置项）。

## 五、报告与诚实性设计（差异化关键）

- 输出：各题分布、按维度交叉表、开放题主题聚类、**与 AI 建议人群 vs 用户修改人群的对照**。
- 每份报告头部固定声明：「合成样本（N=xxx），仅用于假设探索与问卷预筛选，不构成市场结论；重要决策需真人样本验证」。
- 附"可靠性提示"：开放题回答丰富度、persona 间答案差异度（过低=模式同质化预警）。

## 六、排期（最快 2 周切法）

| 周 | 内容 |
|---|---|
| W1 | DB 迁移 + surveys 模块 CRUD + insight-agent 两个 task + 单测（照抄现有 102 测的风格） |
| W2 | 作答 worker（复用调度限流）+ 聚合报告 + web 向导页 + 合成声明 |

**明确不做（首版）**：真人投放回收、多轮对话式访谈、社会仿真引擎接入、persona 记忆/跨轮一致性——均为后续迭代项。

## 七、人群库流水线（Persona Hub 引入版，已确认）

采用四步流水线生成人群库，产物是**平台级共享资产**（不绑定单次问卷）：

| 步骤 | 内容 | 实现 |
|---|---|---|
| 1 结构化增强 | 对 Persona Hub 20 万条文本描述跑 `persona_enrich` 任务，提取职业/性格/视角；原文无的维度（年龄/城市/收入）标 null 不猜测；记录置信度 | 离线批处理，worker 跑 |
| 2 映射入格 | 按「职业组→年龄×收入条件分布表」（CFPS/统计局公开交叉表）代码注入缺失属性，避免不可能组合 | 纯代码，无 LLM |
| 3 配额重采样 | 按品类配额骨架从池中抽样入库，缺口格子用 LLM 定向补充生成（source=generated）；每条带 `weight` 与 `source` 字段 | 代码 + 少量 LLM |
| 4 真人数据校准 | 用已有真人问卷题对比加权分布，偏差反调配额/生成参数 | 后台任务 |

风险（保留）：① Persona Hub 语义内核源自英文网络语境，属性对齐中国人口后态度仍可能有文化偏差，中国本土人格用定向生成补充；② LLM 提取字段准确率需先以 500 条人工标注验证（目标 >85%）；③ **商用前必须核验 Persona Hub 数据使用条款（阻断性前置条件）**。

## 八、平台一级菜单信息架构

在 `apps/web/src/components/shell.tsx` 的主导航中新增一级菜单「超级问卷」，位于「行业洞察」与「报告中心」之间：

```
总览
品牌洞察（排名/竞品/引用/口碑）
行业洞察
超级问卷                    ← 新增一级菜单（折叠组）
  ├─ 问卷      /surveys            列表 + 状态（草稿/生成中/待选人群/运行中/已完成）
  ├─ 人群库    /surveys/pools      平台级 persona 池：配额模板、池详情、校准状态
  └─ 调研报告  /surveys/reports    合成样本报告（固定含合成声明）
报告中心
配置
平台后台
```

新建调研四步向导（用户拥有最终决策权）：

1. **目标与问卷**：输入调研目标 → LLM `survey_gen` 生成 5–10 题 → 用户可增删改每一题。
2. **人群建议**：AI 从人群库筛选建议池（配额模板实例化，显示每个格子的样本分布图）→ 用户调整维度/配额/样本量 → 点「确认人群」写入 `persona_pools.approved=true`。
3. **运行**：展示预估 token 成本与预计时长 → 确认后入 worker 队列（复用现有限流），逐 persona 调用 `persona_answer`。
4. **报告**：分布、交叉表、开放题主题聚类、同质化预警；头部固定声明「合成样本 N=xxx，仅用于假设探索与问卷预筛选，不构成市场结论」。

新增 API 路由（NestJS，`apps/api/src/surveys/`）：`POST /surveys`、`POST /surveys/:id/questions`、`POST /surveys/:id/pool/approve`、`POST /surveys/:id/run`、`GET /surveys/:id/report`、`GET /pools`、`POST /pools/:id/calibrate`。后台另加：`POST /admin/pipeline/enrich`（Persona Hub 增强批处理）、`GET /admin/pipeline/status`。

## 九、风险提示

1. 合成分布与真实市场可能不符（上一轮调研的 C7/C8 结论），报告措辞必须克制，避免"N=500 调研显示"这类误导性表述。
2. 敏感维度（年龄/性别/地域）必须按真实人口分布做配额，不能随机独立拼接。
3. 每次作答落 `parser_version`，模型或 prompt 升级后可追溯复现。
