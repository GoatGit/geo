-- 0015 超级问卷(docs/11, docs/12):
-- surveys = 一次调研;persona_pools = 用户确认的虚拟人群池;personas = 平台级 persona 档案库
-- (source: persona_hub=增强后的 Persona Hub 档案 / generated=按格子定向生成);
-- survey_responses = 逐 persona 逐问卷的回答。合成样本仅用于假设探索,报告必须带声明。
create table if not exists surveys (
  id bigserial primary key,
  account_id bigint not null,
  brand_id bigint,
  title text not null,
  objective text not null,
  status text not null default 'draft',        -- draft/generating/ready_selecting/running/completed/failed
  questions jsonb not null default '[]',       -- [{id,type,text,options[]}],用户可编辑
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists surveys_account_idx on surveys(account_id, status);

create table if not exists persona_pools (
  id bigserial primary key,
  survey_id bigint not null references surveys(id) on delete cascade,
  spec jsonb not null,                         -- 配额模板实例:{segments:[{...attrs,count}]}
  size integer not null default 0,
  approved boolean not null default false,     -- 用户最终决策:approved 前禁止运行
  calibration_status text not null default 'uncalibrated', -- uncalibrated/running/passed
  created_at timestamptz not null default now()
);

create table if not exists personas (
  id bigserial primary key,
  pool_id bigint not null references persona_pools(id) on delete cascade,
  profile jsonb not null,                      -- 结构化档案(职业/年龄带/城市线级/收入带/性格/媒介习惯…)
  source text not null default 'generated',    -- persona_hub/generated
  weight real not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists personas_pool_idx on personas(pool_id);

create table if not exists survey_responses (
  id bigserial primary key,
  survey_id bigint not null references surveys(id) on delete cascade,
  persona_id bigint not null references personas(id) on delete cascade,
  answers jsonb not null,                      -- [{questionId,answer,comment?}]
  model text not null,
  parser_version text not null,
  created_at timestamptz not null default now()
);
create index if not exists survey_responses_survey_idx on survey_responses(survey_id);
create unique index if not exists survey_responses_unique_idx on survey_responses(survey_id, persona_id);
