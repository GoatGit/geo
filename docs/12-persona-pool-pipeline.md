# 人群库流水线设计（Persona Hub 引入版）

> 生产状态（2026-09-22）：超级问卷已上线；此文保留设计/阶段验收上下文，最新发布与功能边界见 [生产发布记录](./15-super-survey-production-release-20260922.md)。

> 实现状态（2026-09-22）：已新增 `persona_library` 共享来源档案、`persona_import_jobs` 持久化导入、模型增强与调研抽样快照；真人 CSV/汇总占比校准、偏差报告和有界权重应用均已实现。`personas` 仍存单次调研快照，`library_id` 追溯共享来源。未知人口属性由明确的用户配额赋值，不伪称来自 CFPS/统计局条件分布。实际实现和真实验收见 [扩展验收记录](./14-persona-calibration-acceptance.md)。

> 2026-09-21 ｜ 上游决策：引入腾讯 Persona Hub，用「结构化增强 → 映射入格 → 配额重采样 → 真人数据校准」四步流水线生成问卷人群库。总体功能设计见 `docs/11-super-survey-design.md`。

## 0. 已核验的事实边界

- Persona Hub（tencent-ailab）公开 20 万条 **纯文本人格描述**（HuggingFace `proj-persona/PersonaHub`，jsonl），非结构化字段、非 prompt；完整库宣称 10 亿条未公开。
- 描述粒度偏职业/视角（如"关注算法公平性的数据科学教授"），**缺年龄、城市线级、收入带**等配额属性。
- 派生自英文网页文本：职业偏 IT/学术/创意，年龄偏中青年，态度带西方网络语境。
- **2026-09-22 已核验：官方数据为 CC-BY-NC-SA-4.0，代码为 MIT；数据仅适用于非商业研究，商业使用需另行授权。当前已接通本地研究；生产需配置已取得的授权记录。**

流水线产物定位：**平台级共享人群库**（`personas` 表），不绑定单次问卷；每条 persona 带 `weight`（配额权重）与 `source`（persona_hub / generated）。

## 1. 结构化增强（`persona_enrich`，离线批处理）

- 走 insight-agent 通道，新增 `persona_enrich` task：输入原文描述，输出结构化 JSON：
  - 提取：`occupation`、`occupation_group`（映射到标准职业大类）、`traits[]`、`media_habits[]`
  - 估计（带置信度）：`age_band_est`、`income_band_est`
  - 原文没有的字段一律 **null，不猜测**
- 准确率闸门：先人工标注 500 条测提取准确率，**≥85% 才批量跑全量**；失败样本进重试/人工队列。
- 落表 `persona_hub_raw`（原文 + 增强 JSON + enrich 版本号），与主库 `personas` 分离，可重跑。

## 2. 映射入格（纯代码，无 LLM）

- 建「职业组 → 年龄 × 收入带条件分布表」`occupation_joint_dist`（配置表），来源：国家统计局公开交叉表、CFPS/CHFS 公开微观数据。
- 每条 persona 按其 `occupation_group` 的**条件分布**注入缺失属性——不是独立均匀抽样，保证不会出现"18 岁教授"等不可能组合，且边际分布正确。
- `city_tier` 按"该职业组 × 年龄带"的城市分布条件注入。

## 3. 配额重采样（代码为主，缺口补生成）

- 品类配额骨架 `quota_templates`（如新能源车主：城市线级 × 年龄 × 收入带 × 预算意向，比例来自行业报告 + 本平台 GEO 观察）。
- 从增强池按配额**有放回抽样**写入 `personas`；某格子不足时，用 LLM `persona_gen` 按格子约束**定向补充生成**（`source=generated`，中文化人格），不从原池硬凑。
- 抽样入池时计算并写入 `weight`（配额反概率权重），聚合统计一律加权。

## 4. 真人数据校准（后台任务 + 校准页）

- 选 2–3 道有真人分布的历史问题（公 icy 民调题或客户旧问卷），池子作答后对比加权分布 vs 真实分布。
- 输出维度级偏差报告（如"收入敏感度整体偏高 12pt"）；处置手段：调注入分布参数 / 定向补生成 / 维度加权。
- 校准状态展示在 `/surveys/pools` 页：`未校准 / 校准中 / 达标（预设阈值，如排序一致率 ≥80%）`。

## 5. 已知局限（对内对外都要讲）

1. **语义偏差不可完全消除**：结构化属性对齐中国人口 ≠ 态度分布对齐；对中国本土人格（如三线城市家庭决策者），定向生成的 persona 应占相当比例，不要迷信 Persona Hub 覆盖。
2. 提取字段是估计值，报告交叉分析只使用 `confidence` 达标字段。
3. 所有基于本池的报告必须带合成样本声明（见 11 号文档 §8）。

## 6. 管理端接口

- `POST /admin/pipeline/enrich`：启动/恢复增强批处理（参数：批大小、模型）
- `GET /admin/pipeline/status`：各步进度（raw 处理量、入格量、入池量、校准状态）
- `POST /pools/:id/calibrate`：提交校准问题集

## 7. 实施顺序

1. 核验 Persona Hub 使用条款（阻断项，先行）
2. `persona_hub_raw` 表 + `persona_enrich` task + 500 条标注验证
3. `occupation_joint_dist` / `quota_templates` 配置表 + 映射入格与重采样脚本
4. 校准任务与 pools 页校准状态
