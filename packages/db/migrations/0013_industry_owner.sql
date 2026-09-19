-- 0013 行业洞察自服务(docs/01 IA ⑤):行业由用户自己新增/删除/配置。
-- account_id = 创建者(用户自建行业仅创建者可见可管);null = 平台配置的公共行业。
alter table insight_industries add column if not exists account_id bigint;
create index if not exists insight_industries_account_idx on insight_industries(account_id);
