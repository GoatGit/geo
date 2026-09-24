-- Shared source assets; survey instances keep immutable copies of the selected persona.
create table if not exists persona_library (
  id bigserial primary key,
  source_key text not null unique,
  description text not null,
  source_url text not null,
  source_revision text not null,
  license text not null default 'CC-BY-NC-SA-4.0',
  profile jsonb,
  status text not null default 'imported',
  parser_version text,
  model text,
  last_error text,
  task_token text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists persona_library_work_idx on persona_library(status, heartbeat_at);
create index if not exists persona_library_occupation_idx on persona_library ((profile->>'occupationGroup')) where status = 'ready';
create table if not exists persona_import_jobs (
  id bigserial primary key,
  requested_by bigint not null,
  status text not null default 'queued',
  requested_count integer not null,
  processed integer not null default 0,
  imported integer not null default 0,
  source_url text not null,
  source_revision text not null,
  license text not null,
  task_token text,
  heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists persona_import_one_active_idx on persona_import_jobs ((true)) where status in ('queued','running');
alter table personas add column if not exists library_id bigint references persona_library(id);
alter table persona_pools add column if not exists source_mode text not null default 'generated';
alter table persona_pools add column if not exists source_stats jsonb not null default '{}';
create table if not exists survey_calibrations (
  id bigserial primary key,
  survey_id bigint not null references surveys(id) on delete cascade,
  pool_id bigint not null references persona_pools(id),
  account_id bigint not null,
  benchmark jsonb not null,
  result jsonb not null,
  applied boolean not null default false,
  response_count integer not null,
  created_at timestamptz not null default now()
);
create index if not exists survey_calibrations_owner_idx on survey_calibrations(account_id, survey_id, id);
alter table persona_pools add column if not exists active_calibration_id bigint references survey_calibrations(id);
