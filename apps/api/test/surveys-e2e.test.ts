import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

/**
 * 超级问卷 e2e(docs/11, docs/12):真实 Postgres(隔离 schema)+ 真实迁移 + 真实 SurveysService,
 * 仅 InsightAgent 用脚本桩(不依赖外部 LLM)。覆盖完整生命周期:
 * 创建 → 生成问卷(含建议人群) → 编辑题目 → 建池 → 未确认禁止运行 → 确认 → 运行 → 加权报告 → 守卫路径。
 */

process.env.NODE_ENV ??= 'test';

/**
 * e2e 库地址:优先 E2E_DATABASE_URL;vitest.config 注入的哑地址(localhost:5)时回落本地开发库(docs/12 流水线验证用)。
 */
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('@localhost:5/')
    ? process.env.DATABASE_URL
    : 'postgres://geo:geo_dev@localhost:15432/geo');

// ---- InsightAgent 桩:按脚本应答,记录调用;usable 可控 ----
const agentState = {
  usable: true,
  surveyScript: null as null | { questions: unknown[]; segments: unknown[] },
  answerScript: null as null | ((profile: Record<string, unknown>, q: { id: string }) => unknown),
  calls: { generateSurvey: 0, personaAnswer: 0 },
};

vi.mock('@geo/insight-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@geo/insight-agent')>();
  class FakeInsightAgent {
    constructor(_: unknown) {}
    get usable() {
      return agentState.usable;
    }
    async generateSurvey(input: { objective: string }) {
      agentState.calls.generateSurvey += 1;
      if (!agentState.surveyScript) return null;
      expect(input.objective.length).toBeGreaterThan(0);
      return { ...agentState.surveyScript, parserVersion: 'stub@p1' } as never;
    }
    async personaAnswer(input: { profile: Record<string, unknown>; questions: Array<{ id: string }> }) {
      agentState.calls.personaAnswer += 1;
      if (!agentState.answerScript) return null;
      const answers = input.questions.map((q) => ({ questionId: q.id, answer: agentState.answerScript!(input.profile, q) }));
      return { answers, parserVersion: 'stub@p1' } as never;
    }
  }
  return { ...actual, InsightAgent: FakeInsightAgent };
});

import { loadPlatformSettings } from '@geo/db';
import { runMigrations } from '@geo/db';
import { createDb } from '@geo/db';
import { brands, accounts } from '@geo/db';
import { SurveyWorker } from '../../worker-web/src/survey-worker';
import { surveys } from '@geo/db';
import { eq } from 'drizzle-orm';
import { SurveysService } from '../src/surveys/surveys.service';

const QUESTIONS = [
  { id: 'q1', type: 'single', text: '最看重什么?', options: ['价格', '续航', '品牌', '智能'] },
  { id: 'q2', type: 'scale', text: '购买意向 1-10' },
  { id: 'q3', type: 'open', text: '还有什么顾虑?' },
];
const SEGMENTS = [
  { ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '专业技术人员', count: 3 },
  { ageBand: '35-44', cityTier: '新一线', incomeBand: '30-50万', gender: '女', occupationGroup: '企业管理', count: 2 },
];

describe('超级问卷 e2e(隔离 schema,docs/11 全生命周期)', () => {
  const schemaName = `surveys_e2e_${randomUUID().replace(/-/g, '')}`;
  let pool: import('pg').Pool;
  let db: Awaited<ReturnType<typeof createDb>>['db'];
  let service: SurveysService;
  let worker: SurveyWorker;
  let accountId: number;
  let brandId = 0;
  let surveyId = 0;
  let poolId: number;

  beforeAll(async () => {
    const root = new Pool({ connectionString: DB_URL });
    await root.query(`create schema ${schemaName}`);
    await root.end();
    const isolatedUrl = new URL(DB_URL);
    isolatedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
    const created = createDb(isolatedUrl.toString());
    pool = created.pool;
    db = created.db;
    await runMigrations(pool);
    service = new SurveysService(db as never);
    worker = new SurveyWorker(db);
    // loadPlatformSettings 走默认配置(insight 未配置)——本测试用桩,无需写 platform_settings
    await loadPlatformSettings(db);
    const account = (await db.insert(accounts).values({ phone: `138${Date.now()}`.slice(0, 11) }).returning())[0]!;
    accountId = account.id;
    const brand = (
      await db
        .insert(brands)
        .values({ accountId: account.id, name: `蔚来e2e-${randomUUID().slice(0, 6)}`, industry: '汽车' })
        .returning()
    )[0]!;
    brandId = brand.id;
  });

  afterAll(async () => {
    await pool?.end();
    const root = new Pool({ connectionString: DB_URL });
    await root.query(`drop schema if exists ${schemaName} cascade`);
    await root.end();
  });

  it('1. 创建调研草稿:品牌归属校验生效', async () => {
    const s = await service.create({ accountId, brandId, title: '25万SUV购买意向', objective: '测试 25 万价位新 SUV 的购买意向与顾虑' });
    surveyId = s!.id;
    expect(s!.status).toBe('draft');
    await expect(service.create({ accountId: 999, brandId, title: 'x', objective: 'y' })).rejects.toMatchObject({ status: 404 });
  });

  it('2. 生成问卷:题目入库、状态转 ready_selecting、附 AI 建议人群', async () => {
    agentState.surveyScript = { questions: QUESTIONS, segments: SEGMENTS };
    await service.generateSurvey({ accountId, surveyId });
    expect((await service.detail(accountId, surveyId)).status).toBe('generating');
    await worker.processNext();
    const detail = await service.detail(accountId, surveyId);
    const r = { survey: detail, suggestedSegments: detail.suggestedSegments, parserVersion: detail.generationVersion };
    expect(r!.survey.questions).toHaveLength(3);
    expect(r!.survey.status).toBe('ready_selecting');
    expect(r!.suggestedSegments).toEqual(SEGMENTS);
    expect(r!.parserVersion).toBe('stub@p1');
    // 他人账号不可见
    await expect(service.generateSurvey({ accountId: 999, surveyId })).rejects.toMatchObject({ status: 404 });
  });

  it('3. 用户编辑题目:最终决策落在数据上;运行/完成态禁止改', async () => {
    const edited = [{ ...QUESTIONS[0]!, text: '你最看重什么?' }, QUESTIONS[1]!, QUESTIONS[2]!];
    const s = await service.updateQuestions({ accountId, surveyId, questions: edited });
    expect(s!.questions[0]!.text).toBe('你最看重什么?');
  });

  it('4. 建池:按配额生成 persona,未确认前禁止运行', async () => {
    const r = await service.createPool({ accountId, surveyId, spec: { segments: SEGMENTS } });
    poolId = r!.poolId;
    expect(r!.size).toBe(5);
    // 未确认 → 409
    await expect(service.run({ accountId, surveyId })).rejects.toMatchObject({ status: 409 });
  });

  it('5. 确认人群(approved 闸门)后运行:逐 persona 作答入库,状态 completed', async () => {
    // priceSensitivity/style 是档案里的稳定维度;回答按其确定性生成,便于断言差异
    agentState.answerScript = (profile, q) => {
      if (q.id === 'q1') return profile.priceSensitivity === '高' ? '价格' : '续航';
      if (q.id === 'q2') return profile.priceSensitivity === '高' ? 3 : 7;
      return `我是${profile.occupationGroup},主要担心售后。`;
    };
    await service.approvePool({ accountId, surveyId, poolId, approved: true });
    const accepted = await service.run({ accountId, surveyId });
    expect(accepted.status).toBe('queued');
    await worker.processNext();
    const r = await service.detail(accountId, surveyId);
    expect(r.progress.completed).toBe(5);
    expect(r.progress.failed).toBe(0);
    expect(r.status).toBe('completed');
    expect(agentState.calls.personaAnswer).toBe(5);
    // 重复运行被拒
    await expect(service.run({ accountId, surveyId })).rejects.toMatchObject({ status: 409 });
  });

  it('6. 报告:合成声明、加权分布、开放题原文', async () => {
    const rep = await service.report(accountId, surveyId);
    expect(rep!.disclaimer).toContain('合成样本');
    expect(rep!.disclaimer).toContain('不构成市场结论');
    const q1 = rep!.questions.find((q) => q.question.id === 'q1')!;
    // priceSensitivity 三档轮转(伪随机种子),高敏感→价格,其余→续航;两类都应出现且份额和为 1
    const sum = q1.distribution.reduce((s, d) => s + d.share, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(q1.distribution.filter(d => d.share > 0).every((d) => ['价格', '续航'].includes(d.value))).toBe(true);
    const q3 = rep!.questions.find((q) => q.question.id === 'q3')!;
    expect(q3.responses.length).toBeGreaterThan(0);
    expect(q3.responses[0]).toContain('担心售后');
    // 他人账号不可见
    await expect(service.report(999, surveyId)).rejects.toMatchObject({ status: 404 });
    // 无作答数据 → 404
    const s2 = await service.create({ accountId, title: '空', objective: '空' });
    await expect(service.report(accountId, s2!.id)).rejects.toMatchObject({ status: 404 });
  });

  it('7. 守卫路径:LLM 不可用 → 运行失败落 failed;重复/非法操作被拒', async () => {
    // 新调研,LLM 不可用
    agentState.usable = false;
    agentState.surveyScript = null;
    const s = await service.create({ accountId, title: 'LLM 不可用', objective: 'x' });
    await expect(service.generateSurvey({ accountId, surveyId: s!.id })).rejects.toMatchObject({ status: 503 });
    agentState.usable = true;
    agentState.surveyScript = { questions: QUESTIONS, segments: SEGMENTS };
    await service.generateSurvey({ accountId, surveyId: s!.id });
    await worker.processNext();
    const p = await service.createPool({ accountId, surveyId: s!.id, spec: { segments: SEGMENTS } });
    await service.approvePool({ accountId, surveyId: s!.id, poolId: p!.poolId, approved: true });
    agentState.answerScript = null; // 作答全失败
    await service.run({ accountId, surveyId: s!.id });
    await worker.processNext();
    const r = await service.detail(accountId, s!.id);
    expect(r.progress.completed).toBe(0);
    expect(r.status).toBe('failed');
    // completed 后再生成被拒
    await expect(service.generateSurvey({ accountId, surveyId })).rejects.toMatchObject({ status: 409 });
    // 空问卷不能建池(服务层先校验问卷再校验配额,均为 409)
    const s3 = await service.create({ accountId, title: '空问卷', objective: 'x' });
    await expect(service.createPool({ accountId, surveyId: s3!.id, spec: { segments: SEGMENTS } })).rejects.toMatchObject({ status: 409 });
    // 越权池操作
    await expect(service.approvePool({ accountId, surveyId, poolId: 999999, approved: true })).rejects.toMatchObject({ status: 404 });
    // 配额非法
    await expect(service.createPool({ accountId, surveyId, spec: { segments: [] } })).rejects.toMatchObject({ status: 400 });
  });

  it('审查回归:拒绝空白目标、非法题目和负数配额', async () => {
    await expect(service.create({ accountId, title: ' ', objective: ' ' })).rejects.toMatchObject({ status: 400 });
    const s = await service.create({ accountId, title: '校验', objective: '验证输入' });
    await expect(service.updateQuestions({ accountId, surveyId: s!.id, questions: [null] as never })).rejects.toMatchObject({ status: 400 });
    await service.updateQuestions({ accountId, surveyId: s!.id, questions: QUESTIONS as never });
    await expect(service.createPool({ accountId, surveyId: s!.id, spec: { segments: [{ ...SEGMENTS[0], count: -2 }, { ...SEGMENTS[1], count: 5 }] } })).rejects.toMatchObject({ status: 400 });
  });

  it('审查回归:完成后不能通过建新池重置问卷状态', async () => {
    await expect(service.createPool({ accountId, surveyId, spec: { segments: SEGMENTS } })).rejects.toMatchObject({ status: 409 });
  });

  it('审查回归:最新人群生效，并发运行只能领取一次，失败只补跑缺失回答', async () => {
    const s = await service.create({ accountId, title: '并发补跑', objective: '检查重复运行' });
    await service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS as never });
    await service.createPool({ accountId, surveyId: s.id, spec: { segments: SEGMENTS } });
    const latest = await service.createPool({ accountId, surveyId: s.id, spec: { segments: [{ ...SEGMENTS[0], count: 3 }] } });
    await service.approvePool({ accountId, surveyId: s.id, poolId: latest.poolId, approved: true });
    const runs = await Promise.allSettled([service.run({ accountId, surveyId: s.id }), service.run({ accountId, surveyId: s.id })]);
    expect(runs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const callsBefore = agentState.calls.personaAnswer;
    agentState.answerScript = (profile, q) => {
      if (profile.sampleKey === '1-1') throw Error('model unavailable');
      return q.id === 'q1' ? '价格' : q.id === 'q2' ? 6 : '售后服务';
    };
    const workers = await Promise.all([worker.processNext(), new SurveyWorker(db).processNext()]);
    expect(workers.filter(Boolean)).toHaveLength(1);
    expect(agentState.calls.personaAnswer - callsBefore).toBe(3);
    expect((await service.detail(accountId, s.id)).progress).toEqual({ total: 3, completed: 2, failed: 1 });
    expect((await service.detail(accountId, s.id)).status).toBe('partial');
    agentState.answerScript = (_, q) => q.id === 'q1' ? '价格' : q.id === 'q2' ? 6 : '售后服务';
    await service.run({ accountId, surveyId: s.id });
    await worker.processNext();
    expect(agentState.calls.personaAnswer - callsBefore).toBe(4);
    expect((await service.detail(accountId, s.id)).status).toBe('completed');
    await expect(service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS as never })).rejects.toMatchObject({ status: 409 });
  });

  it('审查回归:取消后旧作答不能写入，任务中断后可恢复', async () => {
    const s = await service.create({ accountId, title: '取消恢复', objective: '中断测试' });
    await service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS as never });
    const p = await service.createPool({ accountId, surveyId: s.id, spec: { segments: [{ ...SEGMENTS[0], count: 1 }] } });
    await service.approvePool({ accountId, surveyId: s.id, poolId: p.poolId, approved: true });
    await service.run({ accountId, surveyId: s.id });
    let began!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(r => { began = r; });
    const blocked = new Promise<void>(r => { finish = r; });
    const controlled = new SurveyWorker(db, async () => ({ usable: true, personaAnswer: async () => {
      began(); await blocked;
      return { answers: [{ questionId: 'q1', answer: '价格' }, { questionId: 'q2', answer: 5 }, { questionId: 'q3', answer: '售后' }], parserVersion: 'test-v1' };
    } }) as never);
    const pending = controlled.processNext();
    await started;
    await service.cancel(accountId, s.id);
    finish(); await pending;
    expect((await service.detail(accountId, s.id)).status).toBe('cancelled');
    expect((await service.detail(accountId, s.id)).progress.completed).toBe(0);
    await service.run({ accountId, surveyId: s.id });
    await db.update(surveys).set({ status: 'running', taskToken: 'dead-worker', heartbeatAt: new Date(Date.now() - 240000) }).where(eq(surveys.id, s.id));
    await worker.processNext();
    expect((await service.detail(accountId, s.id)).status).toBe('completed');
  });

  it('审查回归:修改题目撤销确认，人群库跨调研列出但不越权', async () => {
    const s = await service.create({ accountId, title: '撤销确认', objective: '修改后重新确认' });
    await service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS as never });
    const p = await service.createPool({ accountId, surveyId: s.id, spec: { segments: SEGMENTS } });
    await service.approvePool({ accountId, surveyId: s.id, poolId: p.poolId, approved: true });
    await service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS.map(q => ({ ...q, text: q.text + '（修改）' })) as never });
    await expect(service.run({ accountId, surveyId: s.id })).rejects.toMatchObject({ status: 409 });
    expect((await service.pools(accountId)).length).toBeGreaterThan(1);
    expect(await service.pools(999)).toEqual([]);
    await expect(service.detail(999, s.id)).rejects.toMatchObject({ status: 404 });
  });

  it('8. 迁移隔离:平台设置读取不受隔离 schema 影响', async () => {
    const settings = await loadPlatformSettings(db);
    expect(settings).toBeTruthy();
  });

  it('历史数据升级保留实际作答的人群，并修复部分结果误标完成', async () => {
    const s = await service.create({ accountId, title: '历史升级', objective: '保留实际结果' });
    await service.updateQuestions({ accountId, surveyId: s.id, questions: QUESTIONS as never });
    const first = await service.createPool({ accountId, surveyId: s.id, spec: { segments: SEGMENTS } });
    const newer = await service.createPool({ accountId, surveyId: s.id, spec: { segments: SEGMENTS } });
    await service.approvePool({ accountId, surveyId: s.id, poolId: newer.poolId, approved: true });
    const person = (await pool.query('select id from personas where pool_id = $1 order by id limit 1', [first.poolId])).rows[0];
    await pool.query("insert into survey_responses(survey_id, persona_id, answers, model, parser_version) values ($1, $2, $3, 'legacy', 'legacy')", [s.id, person.id, JSON.stringify([{ questionId: 'q1', answer: '价格' }, { questionId: 'q2', answer: 7 }, { questionId: 'q3', answer: '售后' }])]);
    await pool.query("update surveys set status = 'completed', active_pool_id = null where id = $1", [s.id]);
    await pool.query(readFileSync(new URL('../../../packages/db/migrations/0016_survey_jobs.sql', import.meta.url), 'utf8'));
    const detail = await service.detail(accountId, s.id);
    expect(detail.pool?.id).toBe(first.poolId);
    expect(detail.status).toBe('partial');
    expect(detail.progress).toEqual({ total: 5, completed: 1, failed: 0 });
    expect((await service.report(accountId, s.id)).sampleSize).toBe(1);
    await service.run({ accountId, surveyId: s.id });
    await worker.processNext();
    expect((await service.detail(accountId, s.id)).status).toBe('completed');
  });

  it('取消生成后可手动编辑，迟到的模型结果不能覆盖新题目', async () => {
    const s = await service.create({ accountId, title: '取消生成', objective: '保留编辑' });
    await service.generateSurvey({ accountId, surveyId: s.id });
    let begin!: () => void, finish!: () => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const controlled = new SurveyWorker(db, async () => ({ usable: true, generateSurvey: async () => {
      begin(); await gate; return { questions: QUESTIONS, segments: SEGMENTS, parserVersion: 'late' };
    } }) as never);
    const task = controlled.processNext();
    await began;
    await service.cancel(accountId, s.id);
    const edited = [{ ...QUESTIONS[0], text: '人工保存题目' }];
    await service.updateQuestions({ accountId, surveyId: s.id, questions: edited as never });
    finish(); await task;
    expect((await service.detail(accountId, s.id)).questions[0].text).toBe('人工保存题目');
  });
});
