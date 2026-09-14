-- 0004 行业洞察(docs/01 §3.10 扩展):管理员后台配置行业与洞察报告;
-- 会员总览展示已发布报告,精选(featured)报告在官网首页公开展示。
CREATE TABLE insight_industries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort       integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE industry_insights (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  industry_id  bigint NOT NULL REFERENCES insight_industries(id),
  issue        text NOT NULL DEFAULT '',
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  cover        jsonb NOT NULL DEFAULT '{}',
  blocks       jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  featured     boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX industry_insights_industry_idx ON industry_insights(industry_id, status, published_at DESC);
