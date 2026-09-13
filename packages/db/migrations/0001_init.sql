-- 0001_init · GeoLens 初始 schema(docs/05 §5 数据模型;docs/07 §8 修正已并入:
-- mention_facts 冗余 ran_at/engine/surface/question_id,全部事实表带 parser_version)

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ============ 账号与认证 ============
CREATE TABLE accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone         text NOT NULL UNIQUE,
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sms_codes (
  phone      text PRIMARY KEY,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ 品牌(工作空间) ============
CREATE TABLE brands (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts (id),
  name       text NOT NULL,
  industry   text,
  website    text,
  intro      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brands_account_idx ON brands (account_id);

-- ============ 监控问题(排名词/口碑词分池,docs/01 §3.2) ============
CREATE TABLE monitoring_questions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id      bigint NOT NULL REFERENCES brands (id),
  type          text NOT NULL CHECK (type IN ('ranking', 'reputation')),
  text_raw      text NOT NULL,
  text_expanded text NOT NULL,
  group_name    text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_brand_type_idx ON monitoring_questions (brand_id, type, status);

-- ============ 识别口径(单一事实源,docs/01 §3.1 / docs/05 §5) ============
CREATE TABLE recognition_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id   bigint NOT NULL REFERENCES brands (id),
  kind       text NOT NULL CHECK (kind IN ('self', 'competitor')),
  name       text NOT NULL,
  aliases    jsonb NOT NULL DEFAULT '[]'::jsonb,
  note       text,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('ai', 'manual')),
  confirmed  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recognition_brand_kind_name_idx ON recognition_entries (brand_id, kind, name);

-- 口径版本化(docs/research 03-B):历史报告按版本复算
CREATE TABLE recognition_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id       bigint NOT NULL REFERENCES brands (id),
  profile        jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now()
);

-- ============ 采集计划与轮次 ============
CREATE TABLE collection_plans (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id   bigint NOT NULL UNIQUE REFERENCES brands (id),
  engines    jsonb NOT NULL,
  surfaces   jsonb NOT NULL,
  freq       int NOT NULL DEFAULT 1 CHECK (freq >= 1),
  timezone   text NOT NULL DEFAULT 'Asia/Shanghai',
  active     boolean NOT NULL DEFAULT true,
  next_run_at timestamptz
);

CREATE TABLE collection_rounds (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id    bigint NOT NULL REFERENCES brands (id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  totals      jsonb
);
CREATE INDEX rounds_brand_started_idx ON collection_rounds (brand_id, started_at DESC);

-- ============ 采集与证据(按月分区,docs/05 §5) ============
CREATE TABLE query_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  brand_id           bigint NOT NULL,
  question_id        bigint NOT NULL,
  engine             text NOT NULL,
  surface            text NOT NULL DEFAULT 'web',
  round_id           bigint,
  status             text NOT NULL CHECK (status IN ('ok_with_answer', 'ok_empty', 'failed', 'quota_blocked')),
  adapter_version    text,
  account_fingerprint text,
  egress_ip          inet,
  ran_at             timestamptz NOT NULL,
  answer_ref         text,
  snapshot_ref       text,
  recording_ref      text,
  evidence_hash      text,
  meta               jsonb,
  PRIMARY KEY (id, ran_at)
) PARTITION BY RANGE (ran_at);
CREATE INDEX query_runs_brand_ran_idx ON query_runs (brand_id, ran_at DESC);
CREATE INDEX query_runs_round_idx ON query_runs (round_id);
CREATE INDEX query_runs_status_idx ON query_runs (status, ran_at DESC);

CREATE TABLE mention_facts (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  run_id        bigint NOT NULL,
  brand_id      bigint NOT NULL,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('self', 'competitor', 'discovered')),
  subject_key   text NOT NULL,
  subject_name  text NOT NULL,
  mentioned     boolean NOT NULL,
  rank          int,
  co_ranked     boolean NOT NULL DEFAULT false,
  ran_at        timestamptz NOT NULL,
  engine        text NOT NULL,
  surface       text NOT NULL DEFAULT 'web',
  question_id   bigint NOT NULL,
  evidence      jsonb,
  parser_version text NOT NULL,
  confidence    real NOT NULL DEFAULT 1,
  PRIMARY KEY (id, ran_at)
) PARTITION BY RANGE (ran_at);
CREATE INDEX mention_facts_brand_ran_idx ON mention_facts (brand_id, ran_at DESC, engine);
CREATE INDEX mention_facts_brand_question_idx ON mention_facts (brand_id, question_id, ran_at DESC);
CREATE INDEX mention_facts_subject_idx ON mention_facts (brand_id, subject_kind, subject_key, ran_at DESC);
CREATE INDEX mention_facts_run_idx ON mention_facts (run_id);

CREATE TABLE citation_facts (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  run_id           bigint NOT NULL,
  brand_id         bigint NOT NULL,
  raw_url          text NOT NULL,
  domain           text NOT NULL,
  platform_category text NOT NULL,
  title            text,
  is_owned         boolean NOT NULL DEFAULT false,
  engine           text NOT NULL,
  question_id      bigint,
  extracted_at     timestamptz NOT NULL,
  parser_version   text NOT NULL,
  PRIMARY KEY (id, extracted_at)
) PARTITION BY RANGE (extracted_at);
CREATE INDEX citation_facts_brand_idx ON citation_facts (brand_id, extracted_at DESC);
CREATE INDEX citation_facts_brand_domain_idx ON citation_facts (brand_id, domain, extracted_at DESC);
CREATE INDEX citation_facts_run_idx ON citation_facts (run_id);

CREATE TABLE reputation_facts (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  run_id           bigint NOT NULL,
  brand_id         bigint NOT NULL,
  sentiment        text NOT NULL CHECK (sentiment IN ('pos', 'neu', 'neg')),
  confidence       real NOT NULL DEFAULT 1,
  impression_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  excerpt          text,
  audit_state      text NOT NULL DEFAULT 'none' CHECK (audit_state IN ('none', 'pending', 'done')),
  ran_at           timestamptz NOT NULL,
  parser_version   text NOT NULL,
  PRIMARY KEY (id, ran_at)
) PARTITION BY RANGE (ran_at);
CREATE INDEX reputation_facts_brand_idx ON reputation_facts (brand_id, ran_at DESC);
CREATE INDEX reputation_facts_run_idx ON reputation_facts (run_id);

-- ============ 聚合与运营 ============
CREATE TABLE daily_metrics (
  brand_id bigint NOT NULL,
  date     date NOT NULL,
  engine   text NOT NULL DEFAULT 'all',
  metrics  jsonb NOT NULL,
  health   jsonb,
  PRIMARY KEY (brand_id, date, engine)
);

CREATE TABLE competitor_candidates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id       bigint NOT NULL REFERENCES brands (id),
  name           text NOT NULL,
  occurrences    int NOT NULL DEFAULT 0,
  context_summary text,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, name)
);

CREATE TABLE subscriptions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES accounts (id),
  brand_id       bigint NOT NULL REFERENCES brands (id),
  plan           text NOT NULL CHECK (plan IN ('free', 'starter', 'standard', 'pro', 'custom')),
  question_quota jsonb NOT NULL,
  engine_quota   jsonb NOT NULL,
  freq           int NOT NULL DEFAULT 1,
  period_end     timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled'))
);
CREATE INDEX subscriptions_brand_idx ON subscriptions (brand_id);

CREATE TABLE credit_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES accounts (id),
  delta         int NOT NULL,
  reason        text NOT NULL,
  ref_id        text,
  balance_after int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_account_idx ON credit_ledger (account_id, created_at DESC);

-- 只追加(docs/02 §7.2:对账以流水为准)
CREATE FUNCTION credit_ledger_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_no_update
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_block_mutation();

CREATE TABLE reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id    bigint NOT NULL REFERENCES brands (id),
  type        text NOT NULL CHECK (type IN ('weekly', 'monthly', 'diagnostic')),
  period      text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'done', 'failed')),
  payload_ref text,
  shared_token text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_brand_idx ON reports (brand_id, created_at DESC);

-- ============ 采集基础设施 ============
CREATE TABLE account_profiles (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  engine        text NOT NULL,
  surface       text NOT NULL DEFAULT 'web',
  fingerprint   jsonb NOT NULL,
  proxy_hint    text,
  context_ref   text,
  health_score  int NOT NULL DEFAULT 100,
  status        text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'cooldown', 'retired', 'banned')),
  daily_used    int NOT NULL DEFAULT 0,
  daily_date    date,
  cooldown_until timestamptz,
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_profiles_pool_idx ON account_profiles (engine, surface, status, health_score DESC);

CREATE TABLE platform_domain_dict (
  domain    text PRIMARY KEY,
  platform  text NOT NULL,
  category  text NOT NULL,
  source    text NOT NULL DEFAULT 'manual' CHECK (source IN ('ai', 'manual')),
  confirmed boolean NOT NULL DEFAULT false
);

CREATE TABLE audit_tasks (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_type  text NOT NULL CHECK (fact_type IN ('mention', 'reputation', 'citation')),
  fact_id    bigint NOT NULL,
  brand_id   bigint,
  reason     text NOT NULL CHECK (reason IN ('low_confidence', 'sampling')),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  labeler    text,
  label      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
