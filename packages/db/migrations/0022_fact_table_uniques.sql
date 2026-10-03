-- 0022 · 事实表业务唯一约束(代码审查 P0-C 对策)
-- 背景:三张事实表只有代理主键 (id, ran_at),无业务唯一键;延迟重排任务重投递
-- (历史 requeue 未带 jobId)与 BullMQ 自身 attempts 重试会造成同一采集被重复
-- 落库,直接打偏提及率/位次口径。本迁移先去重存量,再上唯一索引:
--   mention_facts     (run_id, subject_kind, subject_key)  一次采集对一个主体至多一条判定
--   citation_facts    (run_id, raw_url)                     同一回答中同一 URL 至多计一条
--   reputation_facts  (run_id)                              口碑题为每 run 聚合一行
-- 写入侧(extraction/reputation)同步 onConflictDoNothing。
-- 注:跨 run 级重复(BullMQ 重试生成新 run 行)不在本索引覆盖内,由首发 jobId
-- 防重 + requeue 显式 jobId(processor)收口;残余风险见 docs 代码注释。

-- 存量去重:每组业务键保留最小 id
delete from mention_facts a
  using mention_facts b
  where a.subject_kind = b.subject_kind
    and a.subject_key = b.subject_key
    and a.run_id = b.run_id
    and a.id > b.id;

delete from citation_facts a
  using citation_facts b
  where a.raw_url = b.raw_url
    and a.run_id = b.run_id
    and a.id > b.id;

delete from reputation_facts a
  using reputation_facts b
  where a.run_id = b.run_id
    and a.id > b.id;

create unique index if not exists mention_facts_run_subject_uk
  on mention_facts (run_id, subject_kind, subject_key, ran_at); -- 分区表:唯一索引须含分区键 ran_at(同 run 重放时 ran_at 取自 run 行,值恒同)

create unique index if not exists citation_facts_run_url_uk
  on citation_facts (run_id, raw_url, extracted_at); -- 同上,分区键 extracted_at

create unique index if not exists reputation_facts_run_uk
  on reputation_facts (run_id, ran_at); -- 同上,分区键 ran_at
