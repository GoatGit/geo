-- Durable survey tasks: claimed by worker with a renewable lease; no HTTP request holds LLM work.
alter table surveys add column if not exists suggested_segments jsonb not null default '[]';
alter table surveys add column if not exists active_pool_id bigint references persona_pools(id);
alter table surveys add column if not exists task_token text;
alter table surveys add column if not exists heartbeat_at timestamptz;
alter table surveys add column if not exists last_error text;
alter table surveys add column if not exists generation_version text;
alter table survey_responses add column if not exists status text not null default 'completed';
create index if not exists surveys_work_idx on surveys(status, heartbeat_at);
-- Preserve the pool that actually produced legacy answers, even if a newer pool was approved.
update surveys s set active_pool_id = (
  select p.id from persona_pools p where p.survey_id = s.id
  order by (select count(*) from survey_responses r join personas person on person.id = r.persona_id
            where r.survey_id = s.id and person.pool_id = p.id) desc,
           p.approved desc, p.id desc limit 1
) where s.active_pool_id is null;
-- An already answered pool was approved when the legacy run began. Keep it resumable.
update persona_pools p set approved = true
where exists (select 1 from surveys s where s.active_pool_id = p.id)
  and exists (select 1 from survey_responses r join personas person on person.id = r.persona_id
              where r.survey_id = p.survey_id and person.pool_id = p.id);
update persona_pools p set approved = false
from surveys s where p.survey_id = s.id and s.active_pool_id is not null and s.active_pool_id <> p.id;
-- The old runner marked any non-empty result completed, even when most samples failed.
update surveys s set status = 'partial' from persona_pools p
where p.id = s.active_pool_id and s.status = 'completed'
  and (select count(*) from survey_responses r join personas person on person.id = r.persona_id
       where r.survey_id = s.id and r.status = 'completed' and person.pool_id = p.id) < p.size;
