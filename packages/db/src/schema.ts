import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema —— 与 migrations/0001_init.sql 对应。
 * 分区表的 PARTITION BY 只在 SQL 迁移里声明,这里仅映射列供查询使用。
 */

export const accounts = pgTable('accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  phone: text('phone').notNull().unique(),
  passwordHash: text('password_hash'),
  /** 平台角色:'user' 租户 / 'admin' 平台运营(ADMIN_PHONES 登录时自动授予) */
  role: text('role').notNull().default('user'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const smsCodes = pgTable('sms_codes', {
  phone: text('phone').primaryKey(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const brands = pgTable(
  'brands',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    name: text('name').notNull(),
    industry: text('industry'),
    website: text('website'),
    intro: text('intro'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ accountIdx: index('brands_account_idx').on(t.accountId) }),
);

export const monitoringQuestions = pgTable(
  'monitoring_questions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    textRaw: text('text_raw').notNull(),
    textExpanded: text('text_expanded').notNull(),
    groupName: text('group_name'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ brandTypeIdx: index('questions_brand_type_idx').on(t.brandId, t.type, t.status) }),
);

export const recognitionEntries = pgTable('recognition_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  note: text('note'),
  source: text('source').notNull().default('manual'),
  confirmed: boolean('confirmed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recognitionVersions = pgTable('recognition_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  profile: jsonb('profile').$type<unknown>().notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
});

export const collectionPlans = pgTable('collection_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  engines: jsonb('engines').$type<string[]>().notNull(),
  surfaces: jsonb('surfaces').$type<string[]>().notNull(),
  freq: integer('freq').notNull().default(1),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  active: boolean('active').notNull().default(true),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
});

export const collectionRounds = pgTable(
  'collection_rounds',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    totals: jsonb('totals').$type<Record<string, unknown>>(),
  },
  (t) => ({ brandStartedIdx: index('rounds_brand_started_idx').on(t.brandId, t.startedAt) }),
);

/** 分区表:PARTITION BY RANGE (ran_at),见 migrations/0001_init.sql 与 partitions.ts */
export const queryRuns = pgTable(
  'query_runs',
  {
    id: bigserial('id', { mode: 'number' }),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    questionId: bigint('question_id', { mode: 'number' }).notNull(),
    engine: text('engine').notNull(),
    surface: text('surface').notNull().default('web'),
    roundId: bigint('round_id', { mode: 'number' }),
    status: text('status').notNull(),
    adapterVersion: text('adapter_version'),
    accountFingerprint: text('account_fingerprint'),
    egressIp: text('egress_ip'),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    answerRef: text('answer_ref'),
    snapshotRef: text('snapshot_ref'),
    recordingRef: text('recording_ref'),
    evidenceHash: text('evidence_hash'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.ranAt] }),
    brandRanIdx: index('query_runs_brand_ran_idx').on(t.brandId, t.ranAt),
    roundIdx: index('query_runs_round_idx').on(t.roundId),
    statusIdx: index('query_runs_status_idx').on(t.status, t.ranAt),
  }),
);

export const mentionFacts = pgTable(
  'mention_facts',
  {
    id: bigserial('id', { mode: 'number' }),
    runId: bigint('run_id', { mode: 'number' }).notNull(),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    subjectName: text('subject_name').notNull(),
    mentioned: boolean('mentioned').notNull(),
    rank: integer('rank'),
    coRanked: boolean('co_ranked').notNull().default(false),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    engine: text('engine').notNull(),
    surface: text('surface').notNull().default('web'),
    questionId: bigint('question_id', { mode: 'number' }).notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown> | null>(),
    parserVersion: text('parser_version').notNull(),
    confidence: real('confidence').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.ranAt] }),
    brandRanIdx: index('mention_facts_brand_ran_idx').on(t.brandId, t.ranAt, t.engine),
    brandQuestionIdx: index('mention_facts_brand_question_idx').on(t.brandId, t.questionId, t.ranAt),
    subjectIdx: index('mention_facts_subject_idx').on(t.brandId, t.subjectKind, t.subjectKey, t.ranAt),
    runIdx: index('mention_facts_run_idx').on(t.runId),
  }),
);

export const citationFacts = pgTable(
  'citation_facts',
  {
    id: bigserial('id', { mode: 'number' }),
    runId: bigint('run_id', { mode: 'number' }).notNull(),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    rawUrl: text('raw_url').notNull(),
    domain: text('domain').notNull(),
    platformCategory: text('platform_category').notNull(),
    title: text('title'),
    isOwned: boolean('is_owned').notNull().default(false),
    engine: text('engine').notNull(),
    questionId: bigint('question_id', { mode: 'number' }),
    extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull(),
    parserVersion: text('parser_version').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.extractedAt] }),
    brandIdx: index('citation_facts_brand_idx').on(t.brandId, t.extractedAt),
    brandDomainIdx: index('citation_facts_brand_domain_idx').on(t.brandId, t.domain, t.extractedAt),
    runIdx: index('citation_facts_run_idx').on(t.runId),
  }),
);

export const reputationFacts = pgTable(
  'reputation_facts',
  {
    id: bigserial('id', { mode: 'number' }),
    runId: bigint('run_id', { mode: 'number' }).notNull(),
    brandId: bigint('brand_id', { mode: 'number' }).notNull(),
    sentiment: text('sentiment').notNull(),
    confidence: real('confidence').notNull().default(1),
    impressionTerms: jsonb('impression_terms')
      .$type<Array<{ term: string; polarity: 'pos' | 'neg'; excerpt: string }>>()
      .notNull()
      .default([]),
    excerpt: text('excerpt'),
    auditState: text('audit_state').notNull().default('none'),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    parserVersion: text('parser_version').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.ranAt] }),
    brandIdx: index('reputation_facts_brand_idx').on(t.brandId, t.ranAt),
    runIdx: index('reputation_facts_run_idx').on(t.runId),
  }),
);

export const dailyMetrics = pgTable('daily_metrics', {
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  date: date('date').notNull(),
  engine: text('engine').notNull().default('all'),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
  health: jsonb('health').$type<Record<string, unknown> | null>(),
});

export const competitorCandidates = pgTable('competitor_candidates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  occurrences: integer('occurrences').notNull().default(0),
  contextSummary: text('context_summary'),
  state: text('state').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  plan: text('plan').notNull(),
  questionQuota: jsonb('question_quota').$type<Record<string, unknown>>().notNull(),
  engineQuota: jsonb('engine_quota').$type<Record<string, unknown>>().notNull(),
  freq: integer('freq').notNull().default(1),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  status: text('status').notNull().default('active'),
});

export const creditLedger = pgTable('credit_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  delta: integer('delta').notNull(),
  reason: text('reason').notNull(),
  refId: text('ref_id'),
  balanceAfter: integer('balance_after').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  brandId: bigint('brand_id', { mode: 'number' }).notNull(),
  type: text('type').notNull(),
  period: text('period').notNull(),
  status: text('status').notNull().default('queued'),
  payloadRef: text('payload_ref'),
  sharedToken: text('shared_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountProfiles = pgTable('account_profiles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  engine: text('engine').notNull(),
  surface: text('surface').notNull().default('web'),
  fingerprint: jsonb('fingerprint').$type<Record<string, unknown>>().notNull(),
  proxyHint: text('proxy_hint'),
  contextRef: text('context_ref'),
  healthScore: integer('health_score').notNull().default(100),
  status: text('status').notNull().default('available'),
  dailyUsed: integer('daily_used').notNull().default(0),
  dailyDate: date('daily_date'),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const platformDomainDict = pgTable('platform_domain_dict', {
  domain: text('domain').primaryKey(),
  platform: text('platform').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull().default('manual'),
  confirmed: boolean('confirmed').notNull().default(false),
});

export const auditTasks = pgTable('audit_tasks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  factType: text('fact_type').notNull(),
  factId: bigint('fact_id', { mode: 'number' }).notNull(),
  brandId: bigint('brand_id', { mode: 'number' }),
  reason: text('reason').notNull(),
  state: text('state').notNull().default('pending'),
  labeler: text('labeler'),
  label: jsonb('label').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 平台配置(key-value,管理后台读写;未写入的键取 @geo/shared 默认值)。 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }),
});
