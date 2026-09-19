-- 0014 跨行业洞察(订阅制):行业洞察从"仅本品牌行业"开放为订阅制。
-- account_industry_subs = 账号 × 行业订阅;"我的行业" = 自建(account_id=本人) ∪ 订阅。
-- 配额挂套餐(PLAN_LIMITS.insightIndustries):免费 1 / 入门 1 / 标准 3 / 专业 10 / 定制 ∞。
create table if not exists account_industry_subs (
  account_id bigint not null,
  industry_id bigint not null references insight_industries(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, industry_id)
);
create index if not exists account_industry_subs_industry_idx on account_industry_subs(industry_id);
