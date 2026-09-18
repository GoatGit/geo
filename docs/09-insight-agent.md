# 09 · Insight Agent:LLM 判定层方案(替换规则引擎)

> 状态:**M1-M4 已实施(2026-09-18)**。默认 mode=`rules`(行为与实施前逐字节一致);上线 = 管理后台配置 Insight Agent → `shadow` 影子观察 → `llm` 切主,全程无需发版。
>
> 核心口径(与 docs/02、docs/05 冲突处以本文为准):**LLM 负责"回答里说了什么"的判定,代码负责"事实如何变成指标"的计算。**

---

## 1. 目标与范围

### 1.1 替换(判定层 → Insight Agent)

| # | 任务 | 现状(规则) | 落点 | 规则的已知缺陷 |
|---|------|------------|------|----------------|
| T1 | 品牌识别:提及与否 + 名次 | 双视角包含匹配 + ASCII 词边界 + 滑窗编辑距离([packages/metrics/src/match.ts](../packages/metrics/src/match.ts)) | worker 即时抽取 | 中文无词界,"小米粒电动车"误命中"小米"(0.95 直接入库);变体/代称漏报 |
| T2 | 口碑分析:情绪 + 印象词 | 12+12 硬编码词库 + 句级计数([apps/worker-web/src/reputation.ts](../apps/worker-web/src/reputation.ts)) | 口碑异步队列 | 无否定/程度处理("没有投诉"判负),词库不随行业变 |
| T3 | 问题分类:排名词/口碑词 | 10 个关键词包含([apps/api/src/questions/questions.service.ts:10](../apps/api/src/questions/questions.service.ts#L10)) | 新建问题(同步) | "多少钱/哪个好"全落 ranking |
| T4 | 问题拓写:自然问法 | 3 条模板,丢原文、硬编码 2026([questions.service.ts:17](../apps/api/src/questions/questions.service.ts#L17)) | 新建问题(同步) | 千篇一律,不保留用户语义 |

### 1.2 明确不替换(留在确定性代码)

- **指标计算**:[aggregateDaily](../packages/metrics/src/daily.ts) 的分母/分子、[funnel 嵌套漏斗](../packages/metrics/src/funnel.ts)(提及→上榜→首推)、[compositeRank 的 N+1 中位数](../packages/metrics/src/composite.ts)。这是产品承诺"每一个数字可回溯"的根基,LLM 算比率会引入不可复现与口径漂移。
- **采集工程状态**:QueryRun 四态([shared/enums.ts:10-20](../packages/shared/src/enums.ts)):`ok_with_answer` / `ok_empty` 计入分母,`failed`(采集执行失败)/ `quota_blocked`(账号池耗尽/熔断超限收口)剔除分母但**必须单独计数透出**(`countsTowardsDenominator`;MetricCard 的 `excludedFailed`/`excludedQuotaBlocked`)。这是采集管道的工程状态,LLM 看不到(失败的 run 没有回答文本),永远由代码裁决。
- **引用源归一/去跟踪参数**(citations.ts)、**列表清洗**(cleanMarkdown):纯字符串规整,规则即正确工具。

### 1.3 形态:为什么是"裸 LLM 结构化调用"而不是 agent loop

四个任务均为**单轮、无工具、结构化输出**(输入是现成文本,输出是一次判定)。准确率来自模型 + 口径注入 prompt + JSON Schema 约束 + 校验重试,不来自 agent 循环。因此 Insight Agent 是一个**带统一配置与降级语义的 LLM 判定服务**(一个 package),不是带工具循环的 agent;agent loop 形态(审计副驾、agentic 洞察成稿)列为第 13 节演进方向。

---

## 2. 设计原则(五条,全部有现有机制承接)

1. **LLM 判事实,代码算指标**:LLM 只输出"这条回答里谁被提及、排第几、什么情绪、什么印象词",漏斗/日结函数一行不改。
2. **证据链不松手**:每个判定强制携带原文摘录(evidence/excerpt ≤120 字),复用现有 `mention_facts.evidence`、`reputation_facts.excerpt` 字段——UI"查看证据"直接可用。
3. **永远可降级**:Insight Agent 不可用(未配置/超时/输出非法)→ 自动回落现有规则引擎,采集不中断。规则引擎从"主力"降级为"备胎",**不删除**。
4. **可回溯**:事实行带组合版本文(`parserVersion`),任何一行数据能回答"你是哪套判定逻辑/哪个模型判的"。`auditState` 抽检池机制原样复用。
5. **拦截可见**:影子模式对比结果、降级事件、调用失败率全部可观测(第 10 节),不允许静默。

---

## 3. 总体架构

```
                        ┌─────────────────────────────────────────┐
                        │  platform_settings.insightAgent          │
                        │  (协议/endpoint/apiKey/model/mode)       │
                        └───────────────┬─────────────────────────┘
                                        │ loadInsightAgentConfig()
              ┌─────────────────────────┴────────────────────────┐
              │        packages/insight-agent(新包)              │
              │  · client.ts   openai|anthropic 双协议 fetch 封装 │
              │  · schema.ts   zod 输出校验(4 任务各一份)         │
              │  · prompts.ts  口径注入系统提示(带 promptVersion) │
              │  · index.ts    4 个判定函数 + 降级编排            │
              └──────┬──────────────┬──────────────┬─────────────┘
                     │              │              │
        ┌────────────▼───┐  ┌───────▼────────┐  ┌──▼──────────────────┐
        │ worker 即时抽取 │  │ worker 口碑队列 │  │ API 新建问题(同步)  │
        │ T1 mention     │  │ T2 reputation  │  │ T3 classify T4 expand│
        │ extraction.ts  │  │ reputation.ts  │  │ questions.service.ts │
        │ :58 换判定入口  │  │ :14 换判定入口  │  │ :10/:17 换判定入口   │
        └────────────────┘  └────────────────┘  └─────────────────────┘
                     │              │
                     ▼              ▼
          失败/未启用 → 回落 rules 路径(match.ts / extract.ts / 词库)
```

新包 `@geo/insight-agent` 依赖 `@geo/shared`(类型),不依赖 DB——判定是纯函数式调用,落库仍由现有调用方完成。fetch 直连双协议,**不引 SDK**(仓库惯例:alipay/agentbay 均为裸 fetch)。

---

## 4. 配置设计(管理后台)

### 4.1 存储:platform_settings 新键 `insightAgent`

复用现有 key-value 通道(docs/07;与 `proxyPool.key` 同一存储先例),**无需建表迁移**:

```ts
// packages/shared/src/constants.ts — PLATFORM_SETTING_KEYS 追加
export const PLATFORM_SETTING_KEYS = [
  'schedulerEnabled', 'globalDailyRunCap', 'engineDailyCaps', 'proxyPool',
  'insightAgent',
] as const;

export interface InsightAgentSettings {
  enabled: boolean;            // 总开关(关 = 全量 rules,现状行为)
  mode: 'rules' | 'shadow' | 'llm';  // 见 §6;enabled=false 时强制 rules
  protocol: 'openai' | 'anthropic';
  endpoint: string;            // https URL(openai 兼容:含 /v1;anthropic:网关基址)
  apiKey: string;              // 明文存储(同 proxyPool.key 先例),读取侧掩码
  model: string;               // 如 qwen-max / glm-4.x / claude-sonnet-x
  timeoutMs: number;           // 默认 8000,边界 2000..30000
  maxRetries: number;          // 默认 1(仅对"输出非法/超时"重试,验签/4xx 不重试)
}
```

净化在 `mergePlatformSettings`([shared/constants.ts](../packages/shared/src/constants.ts)):protocol 白名单、endpoint 必须 `https:`、timeoutMs 取整限幅、mode 非法回 `rules`、apiKey 非字符串回空。`PLATFORM_SETTING_KEYS` 封口测试同步扩展([shared/test/platform-settings.test.ts](../packages/shared/test/platform-settings.test.ts))。

### 4.2 env 兜底(无头部署引导)

生效优先级:**platform_settings > 环境变量 > 禁用**。env 仅作首次部署引导:`INSIGHT_AGENT_ENABLED / _MODE / _PROTOCOL / _ENDPOINT / _API_KEY / _MODEL`。后台一旦保存即以库内配置为准。

### 4.3 管理后台 UI 与接口

- **读取**:`GET /admin/settings`([admin.controller.ts:229](../apps/api/src/admin/admin.controller.ts#L229))返回时 **apiKey 掩码**为 `sk-***末4位`;前端拿不到完整 key。
- **写入**:`PUT /admin/settings`([admin.controller.ts:234](../apps/api/src/admin/admin.controller.ts#L234))增补 insightAgent 分支,校验规则对齐 proxyPool 先例(L239-245):`mode='llm'` 时 endpoint/apiKey/model 必填;**apiKey 字段为空字符串 = 保留原值**(掩码回显场景必做,否则一次保存就把 key 冲掉)。
- **前端**:`admin/settings` 页([apps/web/src/app/admin/settings/page.tsx](../apps/web/src/app/admin/settings/page.tsx))新增"Insight Agent"卡片:总开关、模式单选(rules/shadow/llm,附一句话说明)、协议下拉、endpoint、apiKey(password 输入)、model、超时;shadow/llm 模式下展示"测试连接"。
- **测试连接**:`POST /admin/insight-agent/test` → 用配置发一次最小补全(如"回复 ok"),返回 `{ ok, latencyMs, model, error? }`;不入库,失败原因原样返回供排障。

---

## 5. 四个任务规格

通用约定:温度 0;输出强制 JSON(openai 走 `response_format: json_schema`,anthropic 走 tool-use 强制);系统提示带 `promptVersion`(入 parserVersion 组合,§7);zod 校验失败 → 重试 `maxRetries` 次(重试附上一次非法输出与错误说明)→ 仍失败走降级。

### T1 品牌识别(`extractMentionFacts`)

- **调用点**:[extraction.ts:58](../apps/worker-web/src/extraction.ts#L58) 替换 `buildMentionFacts`;**一次调用覆盖全部主体**(本品+竞品+别名整包进 prompt),不是逐主体调用。
- 输入:`{ question, answerMarkdown, subjects: [{key, kind, name, aliases[]}] }`(主体 key 必须来自输入集)。
- 输出 schema:
  ```json
  { "answerEmpty": false,
    "subjects": [{ "key": "self:xiaomisu7", "mentioned": true,
                   "rank": 1, "confidence": 0.97, "excerpt": "1. 小米SU7 …" }] }
  ```
- 判定口径(写进系统提示):`rank` 仅当回答存在**明确序/推荐顺序**时为整数(1 起),散文式提及为 `null`;`mentioned=true` 必须带 **原文逐字摘录** ≤120 字;主体 key 不在输入集 → 丢弃该条并计数(防幻觉);`ok_empty`/空文本的 run **不发起调用**,直接全 false(省 token)。
- 校验后交给现有 `buildMentionFacts` 的落库形态(`MentionFactDraft`):rank 限幅 1..99、同项多主体 `co_ranked` 逻辑保留在调用方拼装层。

### T2 口碑分析(`extractReputation`)

- **调用点**:[reputation.ts:14](../apps/worker-web/src/reputation.ts#L14) 替换词库三分类;异步队列(attempts:3)不变。
- 输入:`{ brandName, answerText }`;输出:
  ```json
  { "sentiment": "pos", "confidence": 0.93,
    "impressions": [{ "term": "续航扎实", "polarity": "pos", "excerpt": "…续航扎实,高速打折少…" }] }
  ```
- 判定口径:**整体情绪以对"本品"的评价为准**(竞品吐槽不算本品负面);必须处理否定("不推荐"= neg);印象词优先**短语级**(不是词库词),每条带逐字摘录;词种去重沿用 [sentiment.ts aggregateImpressions](../packages/metrics/src/sentiment.ts)(同义归并表照旧生效)。
- `auditState`:LLM 高置信(≥0.9)写 `'auto'` 免抽检,其余 `'pending'` 入抽检池——词库时代"全量 0.7 入池"的成本问题顺势解决。

### T3 分类(`classify`)

- **调用点**:[questions.service.ts:10](../apps/api/src/questions/questions.service.ts#L10)。输出 `{ type: 'ranking'|'reputation', confidence }`,prompt 给两条业务定义 + 各 5 例。
- **同步时延预算**:该方法在用户表单提交路径上,超时 `min(timeoutMs, 3000)`;超时/降级回落关键词规则(规则对分类这个低风险任务足够当备胎)。

### T4 拓写(`expand`)

- **调用点**:[questions.service.ts:17](../apps/api/src/questions/questions.service.ts#L17)。输入 `{ text, brandName }`,输出 `{ question }`。
- 硬性要求(写进 schema 约束与 prompt):**必须保留用户原文语义成分**(产品规则"原文与改写文两份"——`textRaw`/`textExpanded` 双列不变);不引入品牌名以外的具体产品断言;长度 ≤60 字;年份不写死(从上下文传 `new Date().getFullYear()`)。

---

## 6. 运行模式与降级矩阵

| mode | 事实来源 | LLM 结果去向 | 用途 |
|------|---------|-------------|------|
| `rules`(默认) | 规则引擎 | 不调用 | 现状行为;一键回退位 |
| `shadow` | 规则引擎(口径不变) | 写入 `query_runs.meta.insightShadow`(判定 JSON + 时延 + token),不进口径 | 灰度评测:与规则/人工审计对比,攒 golden set |
| `llm` | Insight Agent | 直接落 `mention_facts`/`reputation_facts` | 目标态 |

**失败降级矩阵**(mode=`llm` 时):

| 情形 | 行为 |
|------|------|
| 未配置 / enabled=false | 规则路径(不发起调用) |
| 网络错误 / 超时 / 5xx(重试耗尽) | 规则路径;`confidence` 上限压 0.5 → 进抽检池;Redis 计数 `insight:fallback`;console.error(带 runId/任务类型,**不带 key**) |
| 输出非法(JSON 坏/校验败,重试耗尽) | 同上 |
| 部分非法(幻觉主体 key / rank 越界) | 丢弃非法条目,合法条目照常入库;计数 `insight:invalid_partial` |
| answer 为空 / run 非 ok_* | 不调用(省 token,规则同样无从判定) |

一键回退 = 后台把 mode 切回 `rules`,下一 run 即生效,无需发版。

---

## 7. 可回溯与审计

- **parserVersion 组合**:现有 `PARSER_VERSION='v1'`([shared/constants.ts:28](../packages/shared/src/constants.ts#L28))升级为组合串,判定来源自解释:
  - LLM:`insight@{promptVersion}+{protocol}/{model}`,如 `insight@p2+openai/qwen-max`
  - 规则(含降级):`rules@v1`
  - 同一时刻库内可并存多版本事实——审计与重算互不干扰。
- **抽检池**:`mention_facts.confidence < 0.8` 既有约定不变;LLM 低置信判定与**全部降级产生的规则判定**自动入池;`auditState` 人工复核结论是第 11 节 golden set 的数据源。
- **影子对比**(mode=shadow):`query_runs.meta.insightShadow` 存双侧判定 diff 摘要 `{agree, ruleFact, llmFact}`,评测脚本离线扫全量 run 出准确率报告。

---

## 8. 成本与时延预算

- 调用量(以标准套餐 20 题 × 5 引擎为例):T1 每 ok_* run 一次(≈100 次/天/品牌,其中 reputation 型 run 追加 T2 ≈50 次)+ T3/T4 仅问题创建时(个位数/天/品牌)。
- Token 量级:T1 输入 ≈1.5-2.5K(回答全文 + 主体表)、输出 ≈0.3-0.6K;T2 相近。合计 ≈0.4M in / 0.1M out 每天每品牌,按国产旗舰模型价格为**元级/天/品牌**,远低于单品牌订阅毛利的 1%。
- 时延:T1/T2 在 worker 任务内(任务本身有 ASK_TIMEOUT 120s 预算,追加 ≤8s 可接受;进度推送在判定完成后,前端感知为"抽取中"稍延长);T3/T4 同步 3s 上限 + 规则兜底,表单无感。
- 控制:一次调用全主体;空回答短路;`maxRetries=1`;不做流式。

---

## 9. 安全

1. **apiKey**:明文存 `platform_settings`(与 `proxyPool.key` 同先例);读取侧一律掩码;日志/错误信息/`raw` 字段禁止出现 key(client 统一脱敏);后台保存"空 = 保留原值"。
2. **传输**:endpoint 强制 https(净化层拒绝 http/ws)。
3. **SSRF 面**:endpoint 仅管理员可配(AdminGuard 全覆盖),配合 https 限定;不额外做内网段黑名单(管理面可信度足够,若后续开放子管理员再补)。
4. **数据边界**:送出内容 = 引擎公开回答文本 + 品牌口径(名称/别名)+ 监控问题文本;不含用户个人信息、不含 Cookie/凭据。第三方 LLM 条款合规由部署方在选择供应商时确认(docs/06 合规清单追加一行)。
5. **输出当输入防**:LLM 输出只进事实表,永不进入 shell/SQL 拼接(现有 drizzle 参数化照旧);摘录字段长度限幅后才落库。

---

## 10. 可观测性

- **Redis 计数器**(worker 侧,INCR+EXPIRE 日窗):`insight:calls:{task}`、`insight:fallback:{task}`、`insight:invalid_partial`、`insight:shadow_disagree`。
- **后台总览**:admin overview 增一行"Insight Agent":模式、近 24h 调用/降级次数、平均时延(计数器聚合即可,不做新表)。
- **日志规范**:每次调用一条结构化行 `{task, runId, mode, latencyMs, ok, retryUsed}`,失败带错误类型;**不落回答全文与 key**。
- **测试连接**(§4.3)兼作配置排障入口。

---

## 11. 发布计划

| 阶段 | 内容 | 验收标准 |
|------|------|---------|
| **M1 基建** | 新包 + 双协议 client(zod 校验/重试/超时/脱敏)+ 配置净化 + 后台卡片 + 测试连接;`PLATFORM_SETTING_KEYS` 封口与单测 | mode 强制 `rules` 时全量行为与现状逐字节一致;client 双协议 stub 单测绿 |
| **M2 影子** | T1/T2 接 shadow 模式;影子 diff 入 `meta.insightShadow`;离线评测脚本(扫 run 出对比报告) | 目标品牌 ≥7 天影子数据;以抽检池人工结论为 golden set:T1 提及/位次准确率 ≥ 规则基线 +5pct 且幻觉 key 率 <1%;T2 否定句样本组 ≥95% |
| **M3 切主** | T1/T2 mode=llm 上生产(先 1-2 个白名单品牌,后全量);降级链路演练(拔 key/断网注入故障) | 降级率 <2%;抽检池置信度分布健康;单品牌日成本 ≤ 预算上限 |
| **M4 收口** | T3/T4 上线(3s 预算);docs/02 §1.2/§4、docs/05 §2-3 修订;规则引擎标注"降级路径" | 表单 P95 时延不劣化;文档口径一致 |

回滚:任意阶段后台切 `mode=rules` 即回现状,无发版、无数据迁移。

---

## 12. 测试策略

- **client 单测**:fetch stub 覆盖 openai/anthropic 两协议的请求形态、json_schema/tool-force 差异、超时、重试、坏 JSON、key 脱敏。
- **prompt 契约测试**:固定 fixture 回答(列表/散文/否定句/无序)→ 断言解析后的判定 JSON;prompt 变更必须显式更新 `promptVersion` 并同步 fixture(封口测试)。
- **降级编排测试**:按 §6 矩阵逐情形断言(规则回落 + 置信度压 0.5 + 计数器)。
- **golden set 评测**(离线脚本):输入 = 影子期 `meta.insightShadow` + 抽检池人工结论,输出 = 双侧准确率/混淆矩阵,作为 M2→M3 门禁。
- **回归保障**:现有 metrics 全部单测保持绿(规则路径未被删除)。

---

## 13. 非目标与演进(明确不做,留接口)

- **判定任务不用 agent loop**(第 1.3 节已论证);
- 抽检池**审计副驾**(agent 带工具读事实+原文出复核建议)、**行业洞察 agentic 成稿**(现 insight-builder 模板拼装的升级)、**竞品发现接外部搜索**——三者是多步+工具任务,是引入 agent harness(如 [Pi](https://pi.dev/) 的 pi-agent-core)的合理候选,待 M3 稳定后单独立项;
- 多模型路由/成本分级、自动重标注(audit 结论反哺 prompt)——观察 M3 成本与抽检量再定。

---

## 14. 对既有文档的修订点(随 M3/M4 落)

- docs/02 §1.2:识别口径补"判定层 = Insight Agent(LLM),规则为降级路径";§4:口碑情绪/印象词来源同步。
- docs/05 §2:即时抽取步骤补"Insight Agent 调用 + 降级";§3.2:parserVersion 组合串、auditState 语义('auto' 免抽检)。
- docs/06:成本模型加 LLM 判定项;合规清单加"第三方 LLM 供应商条款确认"。
