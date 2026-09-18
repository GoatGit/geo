# 05 · 数据管道与数据模型

## 1. 管道总览

```
QueryRun 完成(带证据包)
   │
   ├─► ① 即时抽取(同步, <2s)      排名/提及判定 —— 规则优先，支撑"分钟级出数"
   │      列表抽取 · 位次标注 · 识别词命中
   │
   └─► ② 批量抽取(异步, 分钟~小时) 引用源 / 印象词 / 情感 —— LLM 批处理
          引用链接归一 · 平台分类 · 印象短语 · 情感三分类
   │
   ▼
③ 口径事实表 (fact tables)  ──►  ④ 指标服务聚合  ──►  页面/报告/导出
```

设计原则：**抽取与采集解耦、抽取带版本、可全量重放**。每个抽取产物记录 `parserVersion`，解析逻辑升级后可对历史证据包重放修正。

## 2. 即时抽取：提及与位次

输入：归一化回答文本（Markdown）。

步骤：
1. **列表结构识别**：识别有序/无序列表块、编号段落；LLM 兜底处理散文式回答。
2. **实体切分**：从列表项中抽取实体名（去修饰词："小米SU7 Ultra" → 候选实体 + 别名匹配）。
3. **品牌匹配**：候选实体对识别口径做匹配——精确 → 别名 → 模糊（编辑距离 + LLM 判定兜底）；命中即 `mentioned=true, rank=列表序`；散文提及 `mentioned=true, rank=null`。
4. **竞品匹配**：同规则跑竞品口径；未匹配的高频实体进入"竞品发现待确认池"。
5. 产出 `mention_facts` 记录，附命中证据（片段、位置、命中词）。

歧义处理：同一列表项多品牌并存（如对比段落）→ 拆多条事实并标记 `co_ranked`；无法判定时置信度置低进入人工抽检池。

**判定层（2026-09-18 修订）**：提及与位次由 Insight Agent（LLM,一次调用覆盖全部主体）判定,产出与上文完全相同的 `mention_facts` 形态(含逐字摘录证据);规则引擎(match/extract)降级为 fallback。`parserVersion` 记组合串(`insight@{promptVersion}+{protocol}/{model}` 或 `v1` = 规则),mode=shadow 时 LLM 判定写 `query_runs.meta.insightShadow` 供离线评测。配置/降级矩阵/灰度门禁见 docs/09 §5-§6、§11。

## 3. 批量抽取：引用源与口碑

### 3.1 引用源归一
- 来源：回答引用卡 + 正文链接 + （APP 端）引用截帧 OCR 兜底。
- 归一化：URL 去参 → 域名 → 平台主域映射（内部维护 `domain → 平台/分类` 字典：门户/垂媒/UGC/百科/官网…）。
- 每条引用记录：`{runId, 原始URL, 归一域名, 平台分类, 内容标题, 引擎, 问题, 是否自有域名}`。
- 平台字典缺失的域名走 LLM 分类并自动入字典（人工复核队列）。

### 3.2 印象词与情感
- 输入：口碑词问题的回答全文 + 品牌识别词上下文窗口。
- LLM 任务（结构化输出）：`情感三分类 + 置信度 + 印象短语列表(词, 极性, 原文摘录)`。
- 约束：印象词必须携带原文摘录（页面证据链要求）；无摘录的抽取丢弃。
- **抽检校准**：置信度 < 0.8 的进入人工抽检池，人工标注结果回流为 few-shot 样本；抽样率动态维持约 5%。
- **实现（2026-09-18 修订）**：该任务由 Insight Agent 承接(判定仅针对本品,否定/转折按语义处理);高置信（≥0.9）写 `auditState='auto'` 免抽检。词库规则降级为 fallback,配置与降级矩阵见 docs/09。

### 3.3 竞品自动发现
- 滑动窗口（近 7 天）内统计未匹配实体的出现 QueryRun 数与分布。
- 阈值（出现 ≥ 3 次且 ≥ 2 个问题）→ 进入待确认池，AI 附带一句话归纳（"该品牌出现在哪些问题、以什么语境"）。
- **排除规则**：命中本品识别口径（含别名）的实体一律不进竞品池——对应竞品把自家产品列为"最强竞品"的事故（教训 #1）。

## 4. 指标聚合

- **实时层**：页面级查询直接对 `mention_facts`/`citation_facts` 按周期聚合（PG 索引：brand_id + ran_at + engine）。
- **日结层**：每日 T+1 生成 `daily_metrics`（品牌 × 引擎 × 指标），趋势线与报告只读日结层；实时页标注"实时"徽章。
- **物化**：体检标签、漏斗、行动清单在日结后重算；实时页按需现算。
- P1 起 QueryRun 日增 > 5 万时，聚合层迁 ClickHouse，PG 保留业务与明细。

## 5. 数据模型（核心表，PostgreSQL DDL 摘要）

```sql
-- 品牌与配置
brands(id, account_id, name, industry, website, intro, status, created_at)
monitoring_questions(id, brand_id, type 'ranking'|'reputation', text_raw, text_expanded,
                     group_id, status 'active'|'archived', created_at)
recognition_entries(id, brand_id, kind 'self'|'competitor', name, aliases jsonb,
                    note, source 'ai'|'manual', confirmed bool)          -- 识别口径单一事实源;
                                                                         -- 每次变更同步写 recognition_versions,
                                                                         -- 历史报告按版本复算
collection_plans(id, brand_id, engines jsonb, surfaces jsonb, freq, active)

-- 采集与证据
query_runs(id, brand_id, question_id, engine, surface, round_id, status,           -- 分区表(月)
           adapter_version, account_fingerprint, egress_ip, ran_at,
           answer_ref, snapshot_ref, recording_ref, evidence_hash, meta jsonb)
collection_rounds(id, brand_id, started_at, finished_at, totals jsonb)             -- 轮次

-- 抽取事实（全部带 parser_version，可全量重放；按月分区）
mention_facts(id, run_id, brand_id, subject_kind 'self'|'competitor'|'discovered',
              subject_id, mentioned bool, rank int null, co_ranked bool,
              ran_at timestamptz, engine, surface, question_id,          -- 采集时快照,实时聚合不回连 query_runs
              evidence jsonb, parser_version, confidence)
citation_facts(id, run_id, brand_id, raw_url, domain, platform_category,
               title, is_owned, engine, extracted_at, parser_version)
reputation_facts(id, run_id, brand_id, sentiment 'pos'|'neu'|'neg',
                 confidence, impression_terms jsonb, excerpt, audit_state,
                 parser_version)

-- 账号与基础设施
accounts(id, phone, password_hash, status, created_at)                     -- 登录账号
account_profiles(id, engine, surface, fingerprint jsonb, proxy_hint,
                 context_ref, health_score, status,                        -- AgentBay Context 绑定
                 daily_used, cooldown_until, retired_at)                   -- 账号池档案
platform_domain_dict(domain, platform, category, source 'ai'|'manual',
                     confirmed bool)                                       -- 引用归一字典
audit_tasks(id, fact_type 'mention'|'reputation'|'citation', fact_id,
            reason 'low_confidence'|'sampling', state, labeler,
            label jsonb)                                                   -- 人工抽检池
recognition_versions(id, brand_id, profile jsonb, effective_from)          -- 识别口径版本化

-- 聚合与运营
daily_metrics(brand_id, date, engine, metrics jsonb, health jsonb)                 -- 日结
competitor_candidates(id, brand_id, name, occurrences, context_summary,
                      state 'pending'|'accepted'|'rejected')
subscriptions(id, account_id, brand_id, plan, question_quota jsonb, engine_quota jsonb,
              freq, period_end, status)
credit_ledger(id, account_id, delta, reason, ref_id, balance_after, created_at)    -- 只追加
reports(id, brand_id, type 'weekly'|'monthly'|'diagnostic', period, status,
        payload_ref, shared_token, created_at)
```

索引要点：`mention_facts(brand_id, ran_at, engine)`、`mention_facts(brand_id, question_id, ran_at)`、`mention_facts(run_id)`、`citation_facts(brand_id, domain, extracted_at)`；`query_runs` 与各事实表按 `ran_at` 月分区（定时预建），12 个月后原始回答 JSONB 转对象存储冷归档。综合名次按 02 §1.3 口径在日结层固化（`daily_metrics.metrics.composite_rank`），矩阵行尾直读。

## 6. API 面（摘要）

```
POST /brands                          创建品牌(AI解析异步任务)
POST /brands/:id/questions:batch      批量建问题(AI分类+拓写)
POST /brands/:id/recognition          更新识别口径(写新版本,历史按版本复算)
GET  /brands/:id/recognition          当前口径与历史版本
GET  /monitor/rankings?brand&period   指标卡+榜单+矩阵 聚合DTO
GET  /monitor/funnel                  可见性漏斗
GET  /monitor/competitors             竞品榜 + 分引擎矩阵
GET  /monitor/citations               引用明细(分页/筛选)
GET  /reputation                      口碑DTO
GET  /runs/:id/evidence               证据包索引(签名URL)
GET  /runs/progress (WS)              采集队列实时进度
POST /reports/:type:generate          手动触发生成
GET  /reports                         报告列表(生成状态/在线预览/下载)
GET  /account/quota                   配额用量(排名词/口碑词分池+引擎端)
GET  /account/credits                 积分余额与流水
POST /diagnostics:quote / :purchase   体检估价/下单
```

约定：所有指标响应携带 `denominator`（分子/分母）、`excluded`（failed/quota_blocked 计数）、`asOf`（数据时间）、`source: 'realtime'|'daily'`。
