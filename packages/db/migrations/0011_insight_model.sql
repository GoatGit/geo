-- 行业洞察独立数据模型(docs/01 IA ⑤ 重构):行业 → 行业品牌 → 行业问题,
-- 纯粹为报告服务;不占用租户品牌/订阅/配额(此前复用租户建号链路是架构偏差)。
-- 采集经"影子品牌"(哨兵账号名下,识别口径=行业品牌清单)复用既有管道,
-- 聚合按 mention_facts.subject_name 分组还原各行业品牌的三率。
create table if not exists insight_brands (
  id bigserial primary key,
  industry_id bigint not null references insight_industries(id) on delete cascade,
  name text not null,
  aliases jsonb not null default '[]',
  website text,
  positioning text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists insight_brands_industry_idx on insight_brands(industry_id);

create table if not exists insight_questions (
  id bigserial primary key,
  industry_id bigint not null references insight_industries(id) on delete cascade,
  text_raw text not null,
  type text not null default 'ranking',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists insight_questions_industry_idx on insight_questions(industry_id);
