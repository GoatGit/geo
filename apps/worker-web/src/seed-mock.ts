import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  auditTasks,
  brands,
  collectionPlans,
  collectionRounds,
  competitorCandidates,
  createDb,
  creditLedger,
  dailyMetrics,
  ensurePartitions,
  mentionFacts,
  monitoringQuestions,
  platformDomainDict,
  recognitionEntries,
  recognitionVersions,
  reports,
  reputationFacts,
  queryRuns,
  subscriptions,
  accounts,
  accountProfiles,
} from '@geo/db';
import { PLAN_LIMITS, WEB_ENGINES, type EngineId } from '@geo/shared';
import { DEFAULT_DOMAIN_DICT } from '@geo/metrics';
import { buildEvidencePack, createStorageFromEnv } from '@geo/evidence';
import { fingerprintHash } from '@geo/browser-session';
import { eq, sql } from 'drizzle-orm';
import { runInstantExtraction, toSubjects, type SubjectRow } from './extraction';
import { extractReputation } from './reputation';
import { buildReportPayload } from './report-builder';

/**
 * dev mock 数据灌入(docs/01 全链路演示用):
 * 复用真实管道代码(runInstantExtraction / extractReputation / buildEvidencePack /
 * buildReportPayload)按历史时间轴重放,产出与线上采集完全同构的事实层/证据包/日结/报告。
 * 幂等:按 MOCK_PHONE 账号清空后重灌;生产禁用。
 */
const MOCK_PHONE = '13800000001';
const DAYS_FULL = 20; // 完整历史天数(不含今日)

/** pnpm --filter 执行时 cwd=包目录;向上找 pnpm-workspace.yaml 锚定仓库根 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd(), '../..');
}
const REPO_ROOT = findRepoRoot();

// ===== env(未注入时读仓库 .env)=====
loadDotEnv(join(REPO_ROOT, '.env'));
process.env.DATABASE_URL ||= 'postgres://geo:geo_dev@localhost:15432/geo';
// 证据目录锚定仓库根,与「仓库根启动 API」的相对路径解析一致
process.env.EVIDENCE_STORAGE ||= 'local';
process.env.EVIDENCE_LOCAL_DIR ||= 'infra/local-data/evidence';
process.env.EVIDENCE_LOCAL_DIR = resolve(REPO_ROOT, process.env.EVIDENCE_LOCAL_DIR);

const { pool, db } = createDb(process.env.DATABASE_URL);
const storage = createStorageFromEnv();

// ===== 确定性场景数据 =====

const BRAND = {
  name: '小米汽车',
  industry: '新能源汽车',
  website: 'https://www.xiaomiev.com',
  intro: '小米旗下智能电动汽车品牌,主打 SU7/YU7 序列,生态联动与智能驾驶为核心卖点。',
};

const SELF_ALIASES = ['小米SU7', 'SU7', '小米SU7 Ultra', '小米YU7'];

const QUESTIONS = [
  {
    type: 'ranking' as const,
    group: '品牌词',
    raw: '小米SU7 值得买吗',
    expanded: '小米SU7 值得买吗——2026 年有什么值得关注的?',
    base: 0.9,
  },
  {
    type: 'ranking' as const,
    group: '泛推荐词',
    raw: '20万左右纯电轿车推荐',
    expanded: '20万左右的预算,买什么纯电轿车比较好?求推荐',
    base: 0.62,
  },
  {
    type: 'ranking' as const,
    group: '竞品对比',
    raw: '小米SU7和特斯拉Model 3怎么选',
    expanded: '小米SU7 和特斯拉 Model 3 应该怎么选?各自优缺点是什么?',
    base: 0.7,
  },
  {
    type: 'ranking' as const,
    group: '场景词',
    raw: '家里充电方便的新能源轿车',
    expanded: '家里有充电桩,值得推荐的新能源轿车有哪些?',
    base: 0.52,
  },
  {
    type: 'reputation' as const,
    group: '口碑-产品',
    raw: '小米汽车质量怎么样',
    expanded: '小米汽车的质量和口碑到底怎么样?有什么优缺点?',
    base: 0.95,
  },
  {
    type: 'reputation' as const,
    group: '口碑-服务',
    raw: '小米汽车售后服务口碑',
    expanded: '小米汽车的售后服务口碑怎么样?有什么吐槽点?',
    base: 0.85,
  },
];

/** 引擎画像:谁更愿意提本品(位次偏好 + 提及率偏置),与 mock fixtures 的分化一致 */
const ENGINE_PROFILE: Record<EngineId, { bias: number; rivals: string[] }> = {
  doubao: { bias: 0.15, rivals: ['比亚迪海豹', '特斯拉 Model 3', '极氪 001', '小鹏 P7'] },
  deepseek: { bias: 0, rivals: ['比亚迪海豹', '特斯拉 Model 3', '智界 S7', '极氪 001'] },
  wenxin: { bias: -0.1, rivals: ['特斯拉 Model 3', '比亚迪汉 EV', '小鹏 P7', '极氪 001'] },
  qwen: { bias: 0.1, rivals: ['特斯拉 Model 3', '比亚迪海豹', '深蓝 SL03', '零跑 C01'] },
  yuanbao: { bias: -0.15, rivals: ['比亚迪海豹', '极氪 001', '特斯拉 Model 3', '小鹏 P7+'] },
};

const CITATION_POOL: Record<EngineId, Array<{ url: string; title: string }>> = {
  doubao: [
    { url: 'https://www.dongchedi.com/article/9001', title: '20 万级纯电轿车横评' },
    { url: 'https://www.douyin.com/video/7001', title: 'SU7 动态试驾' },
    { url: 'https://www.toutiao.com/article/7101', title: '新能源轿车销量榜解读' },
  ],
  deepseek: [
    { url: 'https://www.zhihu.com/question/5001', title: '20 万预算买什么纯电轿车' },
    { url: 'https://www.autohome.com.cn/news/9002', title: '海豹 vs SU7 对比' },
    { url: 'https://www.163.com/auto/90021', title: '纯电轿车市场分析' },
  ],
  wenxin: [
    { url: 'https://baijiahao.baidu.com/s?id=9003', title: '纯电轿车推荐榜单' },
    { url: 'https://www.yiche.com/xinche/9004', title: 'Model 3 与国产新势力' },
    { url: 'https://www.autohome.com.cn/guide/9005', title: '家用首购纯电指南' },
  ],
  qwen: [
    { url: 'https://www.dongchedi.com/article/9005', title: '纯电轿车怎么选' },
    { url: 'https://www.zhihu.com/question/5202', title: '家用充电桩 installation 经验' },
    { url: 'https://www.bilibili.com/video/7102', title: '五款纯电轿车深度实测' },
  ],
  yuanbao: [
    { url: 'https://new.qq.com/rain/a/9006', title: '微信生态热议车型' },
    { url: 'https://www.dongchedi.com/article/9007', title: '极氪 001 与 SU7 怎么选' },
    { url: 'https://www.toutiao.com/article/7103', title: '新势力交付量点评' },
  ],
};

const OWNED_CITATIONS = [
  { url: 'https://www.xiaomiev.com/su7', title: '小米SU7 官网' },
  { url: 'https://www.xiaomiev.com/su7-ultra', title: '小米SU7 Ultra 官网' },
];

const BRAND_VARIANTS = ['小米SU7', '小米 SU7', '小米SU7 Ultra'];

// ===== 工具 =====

/** mulberry32:确定性伪随机(同一 seed 序列可复现,口径可复现) */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

/** daysAgo 天前(北京白天 10-15 点 → UTC 02-07 点) */
function ranAtFor(daysAgo: number, minuteJitter: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  d.setUTCHours(2 + Math.floor(minuteJitter * 5), Math.floor(minuteJitter * 59), Math.floor(minuteJitter * 59), 0);
  return d;
}

function pickWeighted(weights: number[], r: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = r * total;
  for (let i = 0; i < weights.length; i++) {
    acc -= weights[i]!;
    if (acc <= 0) return i;
  }
  return weights.length - 1;
}

// ===== 场景生成:同一问题×引擎×天 → 确定性回答 =====

interface Scenario {
  status: 'ok_with_answer' | 'ok_empty' | 'failed' | 'quota_blocked';
  answerText: string;
  citations: Array<{ url: string; title?: string }>;
}

function scenarioFor(engine: EngineId, q: (typeof QUESTIONS)[number], daysAgo: number): Scenario {
  const r = rng(`${engine}|${q.raw}|${daysAgo}`);
  // 状态机配比:失败 3% / 配额拦截 2% / 空回答 5%(全部落入四态口径,不含今日)
  const roll = r();
  if (daysAgo > 0 && roll < 0.03) return { status: 'failed', answerText: '', citations: [] };
  if (daysAgo > 0 && roll < 0.05) return { status: 'quota_blocked', answerText: '', citations: [] };
  if (roll < 0.1) return { status: 'ok_empty', answerText: '', citations: [] };

  const progress = 1 - daysAgo / DAYS_FULL; // 0(最早)→ 1(今天):品牌可见性整体上行
  const mentionProb = Math.min(0.97, Math.max(0.12, q.base + ENGINE_PROFILE[engine].bias + 0.25 * progress));
  const mentioned = r() < mentionProb;

  if (q.type === 'reputation') {
    return reputationScenario(engine, q, r, progress, mentioned);
  }
  return rankingScenario(engine, q, r, progress, mentioned);
}

function rankingScenario(
  engine: EngineId,
  q: (typeof QUESTIONS)[number],
  r: () => number,
  progress: number,
  mentioned: boolean,
): Scenario {
  const profile = ENGINE_PROFILE[engine];
  const rivals = [...profile.rivals];
  let list: string[] = [];
  let proseLine: string | null = null;

  if (mentioned) {
    // 列表内 vs 纯散文提及(90% / 10%,覆盖 rank=null 的口径路径)
    const inList = r() < 0.9;
    if (inList) {
      // 位次随时间上行:早期偏向 3-5 名,后期偏向 1-2 名
      const weights = [1, 2, 3, 4, 5].map((rank) => (6 - rank) ** (1 + progress * 1.6));
      const rank = pickWeighted(weights, r()) + 1;
      const variant = BRAND_VARIANTS[Math.floor(r() * BRAND_VARIANTS.length)]!;
      list = rivals.splice(0, 4);
      list.splice(rank - 1, 0, variant);
      list = list.slice(0, 5);
    } else {
      list = rivals;
      proseLine = `此外,${BRAND_VARIANTS[0]} 在智能化和生态联动上的讨论度也不低,建议一并纳入对比。`;
    }
  } else {
    list = [...rivals, '零跑 C01', '深蓝 SL03'].slice(0, 5);
  }

  const lines = [
    `关于「${q.expanded.replace(/[?？]$/, '')}」,综合主流观点可以重点关注以下车型:`,
    '',
    ...list.map((name, i) => `${i + 1}. ${name}`),
    '',
    ...(proseLine ? [proseLine, ''] : []),
    '以上信息综合自公开资料,建议到店试驾后再做决定。',
  ];

  const pool = CITATION_POOL[engine];
  const c1 = pool[Math.floor(r() * pool.length)]!;
  const c2 = r() < 0.25 ? OWNED_CITATIONS[Math.floor(r() * OWNED_CITATIONS.length)]! : pool[(pool.indexOf(c1) + 1) % pool.length]!;
  const citations = c1.url === c2.url ? [c1] : [c1, c2];

  return { status: 'ok_with_answer', answerText: lines.join('\n'), citations };
}

function reputationScenario(
  engine: EngineId,
  q: (typeof QUESTIONS)[number],
  r: () => number,
  progress: number,
  mentioned: boolean,
): Scenario {
  // 情感配比:正面 60% / 中性 25% / 负面 15%(口碑随时间改善,负面占比递减)
  const roll = r() + 0.08 * progress;
  let template: 'pos' | 'neu' | 'neg';
  if (roll < 0.55) template = 'pos';
  else if (roll < 0.85) template = 'neu';
  else template = 'neg';

  const subject = mentioned ? BRAND.name : '这款车型';
  const texts: Record<typeof template, string> = {
    pos: `综合公开讨论,${subject}的口碑整体偏正面。做工与质感被认为有竞争力,车机生态联动是一大亮点,产品力在同价位处于领先水平,多数车主表示愿意推荐给朋友。`,
    neu: `关于${subject}的口碑,目前讨论比较分化。产品与生态体验有竞争力;但售后响应偏慢也被多次提及,保值话题存在争议,建议结合自身需求判断。`,
    neg: `部分用户对${subject}存在投诉:售后服务响应慢、门店体验差,价格被认为偏贵,产品迭代节奏保守,保值顾虑较多,服务体验是目前的主要槽点。`,
  };

  const citations =
    r() < 0.2
      ? [OWNED_CITATIONS[Math.floor(r() * OWNED_CITATIONS.length)]!]
      : [
          { url: 'https://www.zhihu.com/question/5100', title: `${BRAND.name}口碑怎么样` },
          { url: 'https://www.dongchedi.com/article/9101', title: `${q.group}车主真实反馈` },
        ];
  return { status: 'ok_with_answer', answerText: texts[template], citations };
}

// ===== 主流程 =====

async function cleanup(brandIds: number[]) {
  if (brandIds.length > 0) {
    const ids = `{${brandIds.join(',')}}`;
    for (const table of [
      'audit_tasks',
      'mention_facts',
      'citation_facts',
      'reputation_facts',
      'query_runs',
      'daily_metrics',
      'collection_rounds',
      'collection_plans',
      'monitoring_questions',
      'recognition_entries',
      'recognition_versions',
      'competitor_candidates',
      'reports',
      'subscriptions',
    ]) {
      await pool.query(`delete from ${table} where brand_id = any($1::bigint[])`, [ids]);
    }
    await pool.query('delete from brands where id = any($1::bigint[])', [ids]);
  }
  await pool.query('delete from sms_codes where phone = $1', [MOCK_PHONE]);
  // 模拟账号档案(seed:profiles 同源,重灌防重)
  await pool.query("delete from account_profiles where proxy_hint like 'residential:mock:%'");
}

/** 账号固定复用(credit_ledger 外键+append-only 触发器,账号与台账不可删) */
async function ensureAccount(): Promise<number> {
  const existing = await pool.query('select id from accounts where phone = $1', [MOCK_PHONE]);
  if (existing.rows[0]) return Number(existing.rows[0].id);
  const created = await db.insert(accounts).values({ phone: MOCK_PHONE }).returning({ id: accounts.id });
  return created[0]!.id;
}

async function seedBaseEntities(accountId: number): Promise<{ brandId: number }> {
  const brand = (
    await db
      .insert(brands)
      .values({ accountId, ...BRAND })
      .returning({ id: brands.id })
  )[0]!;

  // 识别口径:本品(AI 建议别名,默认确认)+ 已确认竞品(轮次口径固化用)
  await db.insert(recognitionEntries).values({
    brandId: brand.id,
    kind: 'self',
    name: BRAND.name,
    aliases: SELF_ALIASES,
    note: 'AI 建议别名(含自有产品线,默认勾选)',
    source: 'ai',
    confirmed: true,
  });
  for (const [name, note] of [
    ['比亚迪海豹', '直接竞品:20 万级纯电轿车'],
    ['特斯拉 Model 3', '标杆竞品:用户对比高频出现'],
    ['极氪 001', '直接竞品:猎装轿跑'],
    ['小鹏 P7', '直接竞品:智能驾驶标签'],
  ] as const) {
    await db.insert(recognitionEntries).values({
      brandId: brand.id,
      kind: 'competitor',
      name,
      aliases: [],
      note,
      source: 'manual',
      confirmed: true,
    });
  }
  await db.insert(recognitionVersions).values({
    brandId: brand.id,
    profile: {
      self: { name: BRAND.name, aliases: SELF_ALIASES },
      competitors: ENGINE_PROFILE.qwen.rivals.concat(ENGINE_PROFILE.doubao.rivals).filter((v, i, a) => a.indexOf(v) === i),
      takenAt: new Date().toISOString(),
    },
  });

  const limits = PLAN_LIMITS.standard;
  await db.insert(subscriptions).values({
    accountId,
    brandId: brand.id,
    plan: 'standard',
    questionQuota: { ranking: limits.rankingQuota, reputation: limits.reputationQuota },
    engineQuota: { web: limits.webEngines, app: limits.appEngines },
    freq: 1,
    periodEnd: new Date(Date.now() + 25 * 24 * 3600 * 1000),
  });

  const nextRun = new Date();
  nextRun.setUTCHours(3, 40, 0, 0);
  nextRun.setTime(nextRun.getTime() + 24 * 3600 * 1000);
  await db.insert(collectionPlans).values({
    brandId: brand.id,
    engines: [...WEB_ENGINES],
    surfaces: ['web'],
    freq: 1,
    active: true,
    nextRunAt: nextRun,
  });

  // 台账 append-only:仅在账号无流水时写入初始分录(重灌不重复)
  const ledgerCount = await pool.query('select count(*)::int as n from credit_ledger where account_id = $1', [accountId]);
  if ((ledgerCount.rows[0] as { n: number }).n === 0) {
    await db.insert(creditLedger).values([
      { accountId, delta: 500, reason: '注册赠送', balanceAfter: 500 },
      { accountId, delta: 1200, reason: '标准版年付', balanceAfter: 1700 },
      { accountId, delta: -900, reason: '兑换诊断报告×3', balanceAfter: 800 },
    ]);
  }

  // 竞品发现待确认池(未纳入口径的高频实体)
  await db.insert(competitorCandidates).values([
    { brandId: brand.id, name: '智界 S7', occurrences: 12, contextSummary: '华为智选车渠道热度高,常与 SU7 并列讨论' },
    { brandId: brand.id, name: '深蓝 SL03', occurrences: 8, contextSummary: '增程/纯电双动力,价格带重叠' },
    { brandId: brand.id, name: '零跑 C01', occurrences: 6, contextSummary: '性价比标签,多见于低价位推荐列表' },
    { brandId: brand.id, name: '小鹏 P7+', occurrences: 4, contextSummary: '智驾话题中与 SU7 对比' },
    { brandId: brand.id, name: '增程式混动', occurrences: 2, contextSummary: '噪声样本:动力类型词,应拒绝', state: 'rejected' },
  ]);

  // 平台域名字典(内置词典落库,支撑引用源分析复核)
  await db.insert(platformDomainDict).values(
    Object.entries(DEFAULT_DOMAIN_DICT).map(([domain, v]) => ({
      domain,
      platform: v.platform,
      category: v.category,
      source: 'ai', // 字典 CHECK 约束仅允许 ai/manual,取 LLM 自动入字典语义
      confirmed: true,
    })),
  ).onConflictDoNothing();

  // 模拟账号档案(每引擎 2 个,同 seed:profiles)
  for (const engine of WEB_ENGINES) {
    for (let i = 0; i < 2; i++) {
      await db.insert(accountProfiles).values({
        engine,
        surface: 'web',
        fingerprint: { ua: `Mozilla/5.0 GeoLensMock/${engine}${i}`, viewport: '1366x768', locale: 'zh-CN' },
        proxyHint: `residential:mock:${engine}:${i}`,
        contextRef: `mock-context-${engine}-${i}`,
        healthScore: 100,
        status: 'available',
      });
    }
  }

  return { brandId: brand.id };
}

async function replayHistory(brandId: number): Promise<{ questionIds: number[] }> {
  const qRows = await db
    .insert(monitoringQuestions)
    .values(
      QUESTIONS.map((q) => ({ brandId, type: q.type, textRaw: q.raw, textExpanded: q.expanded, groupName: q.group })),
    )
    .returning({ id: monitoringQuestions.id, type: monitoringQuestions.type, text: monitoringQuestions.textExpanded });

  const subjectRows = (await db
    .select({ id: recognitionEntries.id, kind: recognitionEntries.kind, name: recognitionEntries.name, aliases: recognitionEntries.aliases })
    .from(recognitionEntries)
    .where(eq(recognitionEntries.brandId, brandId))) as SubjectRow[];
  const subjects = toSubjects(subjectRows, BRAND.name);
  const ownedDomains = [BRAND.website.replace(/^https?:\/\//, '').split('/')[0]!];

  let nRuns = 0;
  let nFacts = 0;
  let nReputation = 0;

  for (let daysAgo = DAYS_FULL; daysAgo >= 0; daysAgo--) {
    const isToday = daysAgo === 0;
    // 今日:进行中轮次(仅前 3 个引擎已完成,其余排队中)
    const engines = isToday ? WEB_ENGINES.slice(0, 3) : [...WEB_ENGINES];
    const total = QUESTIONS.length * WEB_ENGINES.length;
    const round = (
      await db
        .insert(collectionRounds)
        .values({ brandId, startedAt: ranAtFor(daysAgo, 0.05), totals: { total, enqueued: total, done: 0, ok: 0, failed: 0 } })
        .returning({ id: collectionRounds.id })
    )[0]!;

    let done = 0;
    let ok = 0;
    let failed = 0;

    for (const q of QUESTIONS) {
      const questionId = qRows.find((row) => row.text === q.expanded)!.id;
      for (const engine of engines) {
        const sc = scenarioFor(engine, q, daysAgo);
        const ranAt = ranAtFor(daysAgo, rng(`${engine}|${q.raw}|t|${daysAgo}`)());
        const profileKey = `mock-${engine}-${Math.floor(ranAt.getMinutes() / 30)}`;
        const fingerprint = fingerprintHash(profileKey);

        if (sc.status === 'quota_blocked') {
          await db.insert(queryRuns).values({
            brandId,
            questionId,
            engine,
            surface: 'web',
            roundId: round.id,
            status: sc.status,
            adapterVersion: 'mock-1',
            accountFingerprint: fingerprint,
            ranAt,
            meta: { reason: 'engine_daily_quota', strategy: 'mock-replay' },
          });
          done += 1;
          continue;
        }

        const run = (
          await db
            .insert(queryRuns)
            .values({
              brandId,
              questionId,
              engine,
              surface: 'web',
              roundId: round.id,
              status: sc.status,
              adapterVersion: 'mock-1',
              accountFingerprint: fingerprint,
              ranAt,
            })
            .returning({ id: queryRuns.id })
        )[0]!;

        const pack = buildEvidencePack({
          runId: String(run.id),
          brandId,
          engine,
          surface: 'web',
          adapterVersion: 'mock-1',
          question: q.expanded,
          accountFingerprint: fingerprint,
          status: sc.status === 'failed' ? 'failed' : sc.status,
          answerText: sc.answerText,
          rawHtml: sc.answerText
            ? `<html><body data-engine="${engine}">${sc.answerText.replace(/\n/g, '<br/>')}</body></html>`
            : null,
          citations: sc.citations,
          timing: {
            queuedAt: new Date(ranAt.getTime() - 800).toISOString(),
            firstTokenAt: new Date(ranAt.getTime() - 300).toISOString(),
            completedAt: ranAt.toISOString(),
          },
          engineMeta: { mode: 'mock-replay', seed: `${engine}|${q.raw}|${daysAgo}` },
        });
        for (const f of pack.files) await storage.put(f.path, f.body);
        await db
          .update(queryRuns)
          .set({
            answerRef: pack.refs.answerRef,
            snapshotRef: pack.refs.snapshotRef,
            recordingRef: pack.refs.recordingRef,
            evidenceHash: pack.manifestHash,
            meta: { strategy: 'mock-replay' },
          })
          .where(eq(queryRuns.id, run.id));

        done += 1;
        if (sc.status === 'failed') {
          failed += 1;
          continue;
        }
        ok += 1;

        // 即时抽取:mention_facts + citation_facts(与 worker 同一实现)
        const { facts } = await runInstantExtraction({
          db,
          runId: run.id,
          brandId,
          questionId,
          engine,
          ranAt,
          answerText: sc.answerText,
          citations: sc.citations,
          subjects,
          ownedDomains,
        });
        nFacts += facts.length;
        nRuns += 1;

        if (q.type === 'reputation' && sc.answerText) {
          await extractReputation(db, { runId: run.id, brandId, answerText: sc.answerText, ranAt: ranAt.toISOString() });
          nReputation += 1;
        }
      }
    }

    await db
      .update(collectionRounds)
      .set({
        totals: { total, enqueued: total, done, ok, failed },
        finishedAt: isToday ? null : ranAtFor(daysAgo, 0.9),
      })
      .where(eq(collectionRounds.id, round.id));
  }

  console.log(`replayed ${nRuns} ok runs (facts=${nFacts}, reputation=${nReputation})`);
  return { questionIds: qRows.map((row) => row.id) };
}

/** 日结层回填(与 MonitorService.rebuildDaily 同构) */
async function backfillDaily(brandId: number) {
  const res = await pool.query(`
    select date_trunc('day', ran_at)::date::text as day, engine,
      count(*) filter (where subject_kind = 'self')                                     as valid,
      count(*) filter (where subject_kind = 'self' and mentioned)                       as mentioned,
      count(*) filter (where subject_kind = 'self' and mentioned and rank <= 3)         as top3,
      count(*) filter (where subject_kind = 'self' and mentioned and rank = 1)          as top1,
      count(*) filter (where subject_kind = 'self' and mentioned and rank is not null)  as ranked,
      avg(rank) filter (where subject_kind = 'self' and rank is not null)               as avg_rank
    from mention_facts
    where brand_id = $1 and subject_kind = 'self'
    group by 1, 2
  `, [brandId]);
  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
  for (const row of res.rows as Array<Record<string, string | number | null>>) {
    const valid = Number(row.valid);
    const mentioned = Number(row.mentioned);
    const top3 = Number(row.top3);
    const top1 = Number(row.top1);
    const ranked = Number(row.ranked ?? 0);
    await db
      .insert(dailyMetrics)
      .values({
        brandId,
        date: String(row.day),
        engine: String(row.engine),
        metrics: {
          valid,
          mentioned,
          top3,
          top1,
          ranked,
          mentionRate: rate(mentioned, valid),
          top3Rate: rate(top3, ranked),
          top1Rate: rate(top1, ranked),
          avgRank: row.avg_rank != null ? Number(Number(row.avg_rank).toFixed(2)) : null,
        },
      })
      .onConflictDoUpdate({
        target: [dailyMetrics.brandId, dailyMetrics.date, dailyMetrics.engine],
        set: { metrics: sql`excluded.metrics` },
      });
  }
  console.log(`backfilled ${res.rows.length} daily metric rows`);
}

async function seedAuditAndReports(brandId: number) {
  // 低置信 mention 事实 → 人工抽检池
  const lowConf = await db
    .select({ id: mentionFacts.id })
    .from(mentionFacts)
    .where(sql`${mentionFacts.brandId} = ${brandId} and ${mentionFacts.confidence} < 0.8`)
    .limit(10);
  if (lowConf.length > 0) {
    await db.insert(auditTasks).values(
      lowConf.map((f) => ({
        factType: 'mention',
        factId: f.id,
        brandId,
        reason: 'low_confidence',
        state: 'pending',
      })),
    );
  }

  // 口碑抽检:老事实模拟已完成复核,近 3 天保留 pending
  const rep = await db
    .select({ id: reputationFacts.id, ranAt: reputationFacts.ranAt })
    .from(reputationFacts)
    .where(eq(reputationFacts.brandId, brandId));
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  for (const [i, r] of rep.entries()) {
    if (r.ranAt.getTime() < cutoff) {
      // audit_state CHECK 仅允许 none/pending/done;老事实视为复核完成
      await db.update(reputationFacts).set({ auditState: 'done' }).where(eq(reputationFacts.id, r.id));
    } else if (i % 2 === 0) {
      await db.insert(auditTasks).values({
        factType: 'reputation',
        factId: r.id,
        brandId,
        reason: 'sampling',
        state: 'pending',
      });
    }
  }

  // 报告:周报/月报已完成(payload 归档至证据存储),诊断报告排队中
  const weeklyPeriod = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const monthlyPeriod = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 7);
  for (const [type, period, status] of [
    ['weekly', weeklyPeriod, 'done'],
    ['monthly', monthlyPeriod, 'done'],
    ['diagnostic', new Date().toISOString().slice(0, 10), 'queued'],
  ] as const) {
    const row = (
      await db.insert(reports).values({ brandId, type, period, status }).returning({ id: reports.id })
    )[0]!;
    if (status !== 'done') continue;
    const payload = await buildReportPayload(db, brandId, type, period);
    const key = `evidence/reports/${row.id}/payload.json`;
    await storage.put(key, Buffer.from(JSON.stringify(payload, null, 2)));
    await db
      .update(reports)
      .set({
        payloadRef: key,
        sharedToken: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      })
      .where(eq(reports.id, row.id));
  }
  console.log(`seeded reports + ${lowConf.length} audit tasks`);
}

async function main() {
  console.log(`evidence root: ${process.env.EVIDENCE_LOCAL_DIR}`);
  await ensurePartitions(pool);

  // 清空旧 mock 品牌域 + 本地证据存储(dev mock 专属,重灌幂等);账号与台账固定复用
  const prev = await pool.query<{ id: string }>(
    'select id from brands where account_id in (select id from accounts where phone = $1)',
    [MOCK_PHONE],
  );
  await cleanup(prev.rows.map((r) => Number(r.id)));
  rmSync(join(process.env.EVIDENCE_LOCAL_DIR!, 'evidence'), { recursive: true, force: true });

  const accountId = await ensureAccount();
  const { brandId } = await seedBaseEntities(accountId);
  await replayHistory(brandId);
  await backfillDaily(brandId);
  await seedAuditAndReports(brandId);

  const counts = await pool.query<{ table_name: string; n: string }>(`
    select 'query_runs' table_name, count(*)::text n from query_runs where brand_id = $1
    union all select 'mention_facts', count(*)::text from mention_facts where brand_id = $1
    union all select 'citation_facts', count(*)::text from citation_facts where brand_id = $1
    union all select 'reputation_facts', count(*)::text from reputation_facts where brand_id = $1
    union all select 'daily_metrics', count(*)::text from daily_metrics where brand_id = $1
    union all select 'collection_rounds', count(*)::text from collection_rounds where brand_id = $1
    union all select 'reports', count(*)::text from reports where brand_id = $1
    union all select 'audit_tasks', count(*)::text from audit_tasks where brand_id = $1
  `, [brandId]);
  console.log(`brand=${brandId} phone=${MOCK_PHONE}`);
  for (const r of counts.rows) console.log(`  ${r.table_name}: ${r.n}`);
  await pool.end();
}

void main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
