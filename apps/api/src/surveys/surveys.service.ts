import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { brands, loadPlatformSettings, personaPools, personaLibrary, surveyCalibrations, type PoolSpec, personas, surveyResponses, surveys, type SurveyQuestion } from '@geo/db';
import { InsightAgent } from '@geo/insight-agent';
import { aggregateSurvey, SURVEY_DIMENSIONS, validateSurveyQuestions, validateSurveySegments, type SurveyDimension } from '@geo/shared';
import { createHash } from 'node:crypto';
import { personaHubAllowed } from './persona-library.service';
import { DB } from '../common/infra.module';

type Survey = typeof surveys.$inferSelect;
type Database = Pick<NodePgDatabase, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
const conflict = (message: string): never => { throw new HttpException(message, HttpStatus.CONFLICT); };
const badRequest = (message: string): never => { throw new HttpException(message, HttpStatus.BAD_REQUEST); };
const publicSurvey = ({ taskToken: _token, heartbeatAt: _beat, ...row }: Survey) => row;

/* ===== 生成人物的生活化档案(确定式,无额外 LLM 成本):字段之间保持生活逻辑自洽 ===== */
const SURNAME = ['李', '王', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '宋'];
const GIVEN_M = ['浩然', '子轩', '俊杰', '志强', '文博', '明辉', '一鸣', '海涛'];
const GIVEN_F = ['诗涵', '雨婷', '梦琪', '静怡', '丽娟', '雪梅', '欣怡', '倩云'];
const CITIES: Record<string, string[]> = {
  一线: ['北京', '上海', '广州', '深圳'],
  新一线: ['杭州', '成都', '武汉', '西安', '苏州', '南京', '长沙', '重庆'],
  二线: ['合肥', '济南', '温州', '中山', '哈尔滨', '石家庄'],
  三线及以下: ['洛阳', '汕头', '绵阳', '菏泽', '赣州', '岳阳'],
};
const JOBS: Record<string, string[]> = {
  专业技术人员: ['软件工程师', '会计师', '中学教师', '平面设计师', '护士', '机械工程师'],
  企业管理: ['部门经理', '运营总监', '创业公司合伙人', '区域经理'],
  办事人员: ['行政专员', '人事助理', '出纳', '文员'],
  商业服务业: ['门店店长', '销售顾问', '电商客服', '婚礼策划师'],
  农林牧渔: ['种植大户', '养殖户', '农资经销'],
  生产运输: ['工厂技术员', '货车司机', '仓储管理员'],
  自由职业: ['自媒体博主', '自由摄影师', '家教老师', '网店店主'],
  学生: ['在校大学生', '研究生', '职校学生'],
  退休: ['退休教师', '退休工人', '退休公务员'],
};
const FAMILY: Record<string, string[]> = {
  '18-24': ['和父母同住', '住学校宿舍', '与朋友合租'],
  '25-34': ['单身独居', '与伴侣同居', '已婚暂无孩子', '已婚有一个孩子'],
  '35-44': ['已婚有两个孩子', '已婚有一个孩子', '三代同堂'],
  '45-54': ['已婚,孩子在上中学', '孩子在外地上大学', '单身独居'],
  '55+': ['与子女同住', '老两口生活', '独居'],
};
const CHANNELS_YOUNG = ['小红书', '抖音', 'B站', '微博', '知乎', '播客', '朋友推荐'];
const CHANNELS_MID = ['微信公众号', '抖音', '什么值得买', '知乎', '新闻客户端', '朋友推荐'];
const CHANNELS_SENIOR = ['电视', '微信群', '子女推荐', '新闻客户端'];
const CONSUMPTION: Record<string, Record<string, string>> = {
  理性对比型: { 低: '认准品牌直接下单,更看重省时省心', 中: '看参数也看促销,大促时才囤货', 高: '全网比价、等打折,不为品牌溢价买单' },
  重视口碑型: { 低: '朋友推荐优先,价格不太敏感', 中: '先看评论区差评再决定', 高: '只买口碑爆款,拒绝试错' },
  参数研究型: { 低: '追新款,首发就入手', 中: '看评测视频做决策', 高: '配置拆解到细节才掏钱' },
  体验直觉型: { 低: '喜欢就买,不纠结', 中: '先试过再买,体验优先', 高: '只为刚需买单,拒绝冲动消费' },
};
const pick = <T,>(pool: T[], b: number): T => pool[b % pool.length];

/** 生成人物的生活化档案:配额维度由用户指定,其余字段按 hash 组合但保持年龄×职业×渠道的生活逻辑。 */
function buildGeneratedProfile(seg: PoolSpec['segments'][number], hash: Buffer, sampleKey: string) {
  const gender = seg.gender === '不限' ? ['男', '女'][hash[3]! % 2] : seg.gender;
  const name = pick(SURNAME, hash[4]!) + pick(gender === '男' ? GIVEN_M : GIVEN_F, hash[5]!);
  const city = pick(CITIES[seg.cityTier] ?? CITIES['二线']!, hash[6]!);
  const occupation = pick(JOBS[seg.occupationGroup] ?? JOBS['办事人员']!, hash[7]!);
  const family = pick(FAMILY[seg.ageBand] ?? FAMILY['25-34']!, hash[8]!);
  const ageNum = Number.parseInt(seg.ageBand, 10);
  const base = ageNum >= 55 ? CHANNELS_SENIOR : ageNum >= 35 ? CHANNELS_MID : CHANNELS_YOUNG;
  const channels = [...new Set([pick(base, hash[9]!), pick(base, hash[10]!), pick(base, hash[11]!)])];
  const priceSensitivity = ['低', '中', '高'][hash[0]! % 3];
  const style = ['理性对比型', '重视口碑型', '参数研究型', '体验直觉型'][hash[1]! % 4];
  return {
    sampleKey, name, gender, city, occupation, familyStage: family, channels,
    priceSensitivity, style,
    consumptionNote: CONSUMPTION[style]![priceSensitivity]!,
    headline: `${seg.ageBand}岁 · ${city} · ${occupation}`,
  };
}

@Injectable()
export class SurveysService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}

  private async ownedSurvey(accountId: number, surveyId: number, db: Database = this.db, lock = false) {
    const query = db.select().from(surveys).where(and(eq(surveys.id, surveyId), eq(surveys.accountId, accountId))).limit(1);
    const row = (await (lock ? query.for('update') : query))[0];
    if (!row) throw new HttpException('调研不存在', HttpStatus.NOT_FOUND);
    return row;
  }

  private async editable(survey: Survey, db: Database) {
    if (['generating', 'queued', 'running', 'completed'].includes(survey.status)) conflict('调研正在执行或已完成，不能修改；请新建调研');
    const responses = await db.select({ id: surveyResponses.id }).from(surveyResponses).where(eq(surveyResponses.surveyId, survey.id)).limit(1);
    if (responses.length) conflict('已有作答数据，不能修改问卷和人群；可继续补跑或新建调研');
  }

  private async ensureAgent() {
    const cfg = (await loadPlatformSettings(this.db)).insightAgent;
    if (!new InsightAgent({ settings: cfg }).usable) throw new HttpException('AI 服务未配置或已停用，请联系管理员配置后重试', HttpStatus.SERVICE_UNAVAILABLE);
  }

  async create(input: { accountId: number; brandId?: number; title: string; objective: string }) {
    const title = input.title?.trim(), objective = input.objective?.trim();
    if (!title || title.length > 120 || !objective || objective.length > 2000) badRequest('请输入调研标题（1–120 字）和目标（1–2000 字）');
    if (input.brandId != null) {
      const brand = (await this.db.select({ id: brands.id }).from(brands).where(and(eq(brands.id, input.brandId), eq(brands.accountId, input.accountId))).limit(1))[0];
      if (!brand) throw new HttpException('品牌不存在', HttpStatus.NOT_FOUND);
    }
    return publicSurvey((await this.db.insert(surveys).values({ accountId: input.accountId, brandId: input.brandId ?? null, title, objective }).returning())[0]!);
  }

  /** Committing the status also commits the task. Worker polls PostgreSQL, so enqueue cannot be lost. */
  async generateSurvey(input: { accountId: number; surveyId: number }) {
    await this.ownedSurvey(input.accountId, input.surveyId);
    await this.ensureAgent();
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(input.accountId, input.surveyId, tx, true);
      await this.editable(survey, tx);
      const row = (await tx.update(surveys).set({ status: 'generating', taskToken: null, heartbeatAt: null, lastError: null, updatedAt: new Date() }).where(eq(surveys.id, survey.id)).returning())[0]!;
      return { survey: publicSurvey(row) };
    });
  }

  async updateQuestions(input: { accountId: number; surveyId: number; questions: SurveyQuestion[] }) {
    await this.ownedSurvey(input.accountId, input.surveyId);
    const checked = validateSurveyQuestions(input.questions);
    if (!checked.ok) return badRequest(checked.errors.join('；'));
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(input.accountId, input.surveyId, tx, true);
      await this.editable(survey, tx);
      if (JSON.stringify(survey.questions) !== JSON.stringify(checked.value)) {
        await tx.update(personaPools).set({ approved: false }).where(eq(personaPools.surveyId, survey.id));
      }
      return publicSurvey((await tx.update(surveys).set({ questions: checked.value, status: 'ready_selecting', lastError: null, updatedAt: new Date() }).where(eq(surveys.id, survey.id)).returning())[0]!);
    });
  }

  async createPool(input: { accountId: number; surveyId: number; spec: PoolSpec; sourceMode?: string }) {
    await this.ownedSurvey(input.accountId, input.surveyId);
    const checked = validateSurveySegments(input.spec?.segments);
    if (!checked.ok) return badRequest(checked.errors.join('；'));
    const sourceMode = input.sourceMode ?? 'generated';
    if (!['generated', 'hybrid', 'persona_hub'].includes(sourceMode)) badRequest('不支持的人物来源');
    if (sourceMode !== 'generated' && !personaHubAllowed()) conflict('Persona Hub 当前仅启用于非商业研究环境');
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(input.accountId, input.surveyId, tx, true);
      await this.editable(survey, tx);
      if (!survey.questions.length) conflict('请先生成或填写问卷');
      const size = checked.value.reduce((n, s) => n + s.count, 0);
      const pool = (await tx.insert(personaPools).values({ surveyId: survey.id, spec: { segments: checked.value }, size, sourceMode }).returning())[0]!;
      const rows: Array<typeof personas.$inferInsert> = [];
      let hubCount = 0; const usedLibrary = new Set<number>();
      for (const [segmentIndex, seg] of checked.value.entries()) {
        const candidates = sourceMode === 'generated' ? [] : await tx.select().from(personaLibrary).where(and(
          eq(personaLibrary.status, 'ready'),
          ...(['occupationGroup', 'gender', 'ageBand', 'cityTier', 'incomeBand'] as const).filter(key => seg[key] !== '不限').map(key => sql`(${personaLibrary.profile}->>${key} is null or ${personaLibrary.profile}->>${key} = ${seg[key]})`),
        )).orderBy(sql`md5(${personaLibrary.sourceKey} || ${String(pool.id)})`).limit(Math.min(2000, seg.count));
        if (sourceMode === 'persona_hub' && !candidates.length) conflict(`第 ${segmentIndex + 1} 组没有兼容档案，请先增强更多人物或选择混合来源`);
        for (let i = 0; i < seg.count; i++) {
          const hash = createHash('sha256').update(`${pool.id}/${segmentIndex}/${i}`).digest();
          const attributes = { ageBand: seg.ageBand, cityTier: seg.cityTier, incomeBand: seg.incomeBand, gender: seg.gender, occupationGroup: seg.occupationGroup };
          const hub = candidates.length ? candidates[i % candidates.length] : undefined;
          if (hub) { hubCount++; usedLibrary.add(hub.id); }
          rows.push({ poolId: pool.id, libraryId: hub?.id ?? null, source: hub ? 'persona_hub' : 'generated', profile: {
            ...attributes, ...buildGeneratedProfile(seg, hash, `${segmentIndex + 1}-${i + 1}`),
            ...(hub ? { ...Object.fromEntries(Object.entries(hub.profile ?? {}).filter(([,v]) => v != null)), description: hub.description, provenance: { libraryId: hub.id, sourceUrl: hub.sourceUrl, revision: hub.sourceRevision, license: hub.license, assignedDimensions: Object.keys(attributes).filter(key => hub.profile?.[key] == null), assignment: '用户研究配额，非人口分布估计' } } : {}),
          } });
        }
      }
      for (let i = 0; i < rows.length; i += 200) await tx.insert(personas).values(rows.slice(i, i + 200));
      await tx.update(personaPools).set({ approved: false }).where(eq(personaPools.surveyId, survey.id));
      await tx.update(personaPools).set({ sourceStats: { personaHub: hubCount, generated: size - hubCount, uniqueLibrary: usedLibrary.size } }).where(eq(personaPools.id, pool.id));
      await tx.update(surveys).set({ activePoolId: pool.id, status: 'ready_selecting', lastError: null, updatedAt: new Date() }).where(eq(surveys.id, survey.id));
      return { poolId: pool.id, size };
    });
  }

  async approvePool(input: { accountId: number; surveyId: number; poolId: number; approved: boolean }) {
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(input.accountId, input.surveyId, tx, true);
      const pool = (await tx.select().from(personaPools).where(and(eq(personaPools.id, input.poolId), eq(personaPools.surveyId, survey.id))).limit(1))[0];
      if (!pool) throw new HttpException('人群池不存在', HttpStatus.NOT_FOUND);
      await this.editable(survey, tx);
      if (pool.id !== survey.activePoolId) conflict('人群已更新，请确认当前人群');
      return (await tx.update(personaPools).set({ approved: input.approved }).where(eq(personaPools.id, pool.id)).returning())[0]!;
    });
  }

  async run(input: { accountId: number; surveyId: number }) {
    await this.ownedSurvey(input.accountId, input.surveyId);
    await this.ensureAgent();
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(input.accountId, input.surveyId, tx, true);
      if (['generating', 'queued', 'running', 'completed'].includes(survey.status)) conflict('调研已在执行或已完成，请勿重复运行');
      if (!validateSurveyQuestions(survey.questions).ok) conflict('请先保存有效问卷');
      const pool = survey.activePoolId ? (await tx.select().from(personaPools).where(and(eq(personaPools.id, survey.activePoolId), eq(personaPools.surveyId, survey.id))).limit(1))[0] : null;
      if (!pool?.approved) return conflict('请先确认当前人群，再开始作答');
      await tx.update(personas).set({ weight: 1 }).where(eq(personas.poolId, pool.id));
      await tx.update(personaPools).set({ activeCalibrationId: null, calibrationStatus: 'uncalibrated' }).where(eq(personaPools.id, pool.id));
      await tx.update(surveyCalibrations).set({ applied: false }).where(eq(surveyCalibrations.poolId, pool.id));
      await tx.delete(surveyResponses).where(and(eq(surveyResponses.surveyId, survey.id), eq(surveyResponses.status, 'failed')));
      const row = (await tx.update(surveys).set({ status: 'queued', taskToken: null, heartbeatAt: null, lastError: null, updatedAt: new Date() }).where(eq(surveys.id, survey.id)).returning())[0]!;
      return { status: row.status, surveyId: row.id };
    });
  }

  async cancel(accountId: number, surveyId: number) {
    return this.db.transaction(async tx => {
      const survey = await this.ownedSurvey(accountId, surveyId, tx, true);
      if (!['generating', 'queued', 'running'].includes(survey.status)) conflict('当前没有可取消的任务');
      return publicSurvey((await tx.update(surveys).set({ status: 'cancelled', taskToken: null, heartbeatAt: null, updatedAt: new Date() }).where(eq(surveys.id, surveyId)).returning())[0]!);
    });
  }

  async list(accountId: number) {
    const rows = await this.db.select().from(surveys).where(eq(surveys.accountId, accountId)).orderBy(desc(surveys.id)).limit(200);
    return rows.map(publicSurvey);
  }

  async detail(accountId: number, surveyId: number) {
    const row = await this.ownedSurvey(accountId, surveyId);
    const pool = row.activePoolId ? (await this.db.select().from(personaPools).where(eq(personaPools.id, row.activePoolId)).limit(1))[0] : null;
    const counts = (await this.db.select({
      all: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${surveyResponses.status} = 'completed' and ${personas.poolId} = ${row.activePoolId ?? -1})::int`,
      failed: sql<number>`count(*) filter (where ${surveyResponses.status} = 'failed' and ${personas.poolId} = ${row.activePoolId ?? -1})::int`,
    }).from(surveyResponses).innerJoin(personas, eq(personas.id, surveyResponses.personaId)).where(eq(surveyResponses.surveyId, surveyId)))[0]!;
    return { ...publicSurvey(row), pool: pool ?? null, progress: { total: pool?.size ?? 0, completed: counts.completed, failed: counts.failed }, editable: !['generating', 'queued', 'running', 'completed'].includes(row.status) && counts.all === 0 };
  }

  async report(accountId: number, surveyId: number, dimension?: string) {
    if (dimension && !Object.prototype.hasOwnProperty.call(SURVEY_DIMENSIONS, dimension)) badRequest('不支持的分组维度');
    const detail = await this.detail(accountId, surveyId);
    const rows = await this.db.select({ answers: surveyResponses.answers, weight: personas.weight, profile: personas.profile }).from(surveyResponses)
      .innerJoin(personas, eq(surveyResponses.personaId, personas.id))
      .where(and(eq(surveyResponses.surveyId, surveyId), eq(surveyResponses.status, 'completed'), eq(personas.poolId, detail.activePoolId ?? -1))).orderBy(asc(personas.id));
    if (!rows.length) throw new HttpException('尚无有效作答，完成作答后可查看报告', HttpStatus.NOT_FOUND);
    const stats = aggregateSurvey(detail.questions, rows, dimension as SurveyDimension | undefined);
    const calibration = detail.pool?.activeCalibrationId ? (await this.db.select().from(surveyCalibrations).where(eq(surveyCalibrations.id, detail.pool.activeCalibrationId)))[0] : null;
    return {
      ...stats, calibration: calibration ?? null, title: detail.title, objective: detail.objective, status: detail.status, updatedAt: detail.updatedAt,
      progress: detail.progress, pool: detail.pool,
      suggestedSegments: detail.suggestedSegments,
      disclaimer: `合成样本报告（有效 N=${rows.length}，计划 ${detail.pool?.size ?? 0}）：仅用于假设探索与问卷预筛选，不构成市场结论；重要决策需真人样本验证。`,
      warnings: [
        calibration ? `已按真人基准「${calibration.benchmark.title}」校准 ${calibration.benchmark.targets.length} 道题；这是拟合结果，不代表其他题目或市场总体已经验证。` : '尚未应用真人数据校准；样本量不代表统计置信度。',
        ...(detail.pool?.sourceStats.personaHub ? ['部分人物来自 Persona Hub；未知人口属性由用户配额赋值，不是该人物的真实人口资料。'] : []),
        ...((detail.pool?.sourceStats.personaHub ?? 0) > (detail.pool?.sourceStats.uniqueLibrary ?? 0) ? [`本次使用 ${detail.pool?.sourceStats.uniqueLibrary} 个不同来源档案进行有放回抽样；重复档案不代表新增真人受访者。`] : []),
        ...(rows.length < (detail.pool?.size ?? 0) ? ['当前仅包含部分样本，缺失回答可能影响分布；可在调研详情中补跑。'] : []),
        ...(rows.length >= 5 && stats.diversity < 0.3 ? ['回答组合较集中，可能存在模型同质化；建议调整人群和题目后交叉验证。'] : []),
      ],
    };
  }

  async pools(accountId: number, surveyId?: number) {
    if (surveyId != null) await this.ownedSurvey(accountId, surveyId);
    return this.db.select({ id: personaPools.id, surveyId: surveys.id, surveyTitle: surveys.title, size: personaPools.size, approved: personaPools.approved, calibrationStatus: personaPools.calibrationStatus, activeCalibrationId: personaPools.activeCalibrationId, sourceMode: personaPools.sourceMode, sourceStats: personaPools.sourceStats, spec: personaPools.spec, active: sql<boolean>`${surveys.activePoolId} = ${personaPools.id}` }).from(personaPools)
      .innerJoin(surveys, eq(surveys.id, personaPools.surveyId))
      .where(and(eq(surveys.accountId, accountId), surveyId == null ? undefined : eq(surveys.id, surveyId))).orderBy(desc(personaPools.id)).limit(200);
  }

  /** 人群逐条查看:分页返回池内 persona 档案(确认人群前可先点名审阅)。 */
  async personaList(input: { accountId: number; surveyId: number; poolId: number; page: number; pageSize: number }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    const pool = (await this.db.select().from(personaPools).where(and(eq(personaPools.id, input.poolId), eq(personaPools.surveyId, survey.id))).limit(1))[0];
    if (!pool) throw new HttpException('人群池不存在', HttpStatus.NOT_FOUND);
    const total = (await this.db.select({ n: sql<number>`count(*)::int` }).from(personas).where(eq(personas.poolId, pool.id)))[0]!.n;
    const items = (await this.db
      .select({ id: personas.id, profile: personas.profile, source: personas.source, weight: personas.weight, libraryId: personas.libraryId })
      .from(personas)
      .where(eq(personas.poolId, pool.id))
      .orderBy(asc(personas.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize));
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  /** 问卷逐条查看:分页返回每份答卷(profile + 逐题回答),供逐条阅读原文。 */
  async responseList(input: { accountId: number; surveyId: number; page: number; pageSize: number; status?: string }) {
    const survey = await this.ownedSurvey(input.accountId, input.surveyId);
    const poolId = survey.activePoolId ?? -1;
    const where = and(eq(surveyResponses.surveyId, survey.id), eq(personas.poolId, poolId),
      input.status === 'completed' || input.status === 'failed' ? eq(surveyResponses.status, input.status) : undefined);
    const total = (await this.db.select({ n: sql<number>`count(*)::int` }).from(surveyResponses)
      .innerJoin(personas, eq(personas.id, surveyResponses.personaId)).where(where))[0]!.n;
    const items = (await this.db
      .select({
        id: surveyResponses.id, personaId: surveyResponses.personaId, answers: surveyResponses.answers,
        status: surveyResponses.status, createdAt: surveyResponses.createdAt,
        profile: personas.profile, source: personas.source,
      })
      .from(surveyResponses)
      .innerJoin(personas, eq(personas.id, surveyResponses.personaId))
      .where(where)
      .orderBy(asc(personas.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize));
    return { items, total, page: input.page, pageSize: input.pageSize, questions: survey.questions };
  }
}
