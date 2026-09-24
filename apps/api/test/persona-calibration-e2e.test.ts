import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDb, runMigrations, accounts, personaLibrary, personas, surveyResponses, surveys } from '@geo/db';
import { eq } from 'drizzle-orm';
import { SurveysService } from '../src/surveys/surveys.service';
import { CalibrationService } from '../src/surveys/calibration.service';
import { PersonaLibraryService } from '../src/surveys/persona-library.service';
import { PersonaLibraryWorker } from '../../worker-web/src/persona-library-worker';
const base = process.env.E2E_DATABASE_URL ?? 'postgres://geo:geo_dev@localhost:15432/geo';
const schema = `persona_e2e_${randomUUID().replaceAll('-', '')}`;
let pool: Pool, db: ReturnType<typeof createDb>['db'], accountId: number;
let service: SurveysService, calibration: CalibrationService, library: PersonaLibraryService;
const questions = [{ id: 'q1', type: 'single' as const, text: '选择', options: ['A','B'] }];
const segments = [{ ageBand: '25-34', cityTier: '二线', incomeBand: '10-20万', occupationGroup: '专业技术人员', gender: '不限', count: 10 }];
const benchmark = { title: '外部真人调查', source: 'https://example.org/poll', population: '测试调查人群', sampleSize: 1000, collectedAt: '2026-09-01', targets: [{ questionId: 'q1', shares: { A: 0.6, B: 0.4 } }] };
beforeAll(async () => {
  const root = new Pool({ connectionString: base }); await root.query(`create schema ${schema}`); await root.end();
  const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`);
  ({ db, pool } = createDb(url.toString())); await runMigrations(pool);
  accountId = (await db.insert(accounts).values({ phone: '13944445555' }).returning())[0]!.id;
  service = new SurveysService(db); calibration = new CalibrationService(db); library = new PersonaLibraryService(db);
});
afterAll(async () => { await pool?.end(); const root = new Pool({ connectionString: base }); await root.query(`drop schema if exists ${schema} cascade`); await root.end(); });
describe('Persona Hub ingestion and sampling', () => {
  it('imports streaming JSONL idempotently with a pinned revision and license', async () => {
    const fetcher = (async () => new Response('{"persona":"A software researcher"}\n{"persona":"A retired teacher"}\n{"persona":"A software researcher"}\n')) as typeof fetch;
    await library.startImport(accountId, 3);
    await expect(library.startImport(accountId, 2)).rejects.toMatchObject({ status: 409 });
    const worker = new PersonaLibraryWorker(db, fetcher);
    await worker.processImport();
    let list = await library.list(); expect(list.counts?.total).toBe(2); expect(list.jobs[0]?.status).toBe('completed');
    expect(list.rows[0]?.license).toBe('CC-BY-NC-SA-4.0'); expect(list.rows[0]?.sourceRevision).toHaveLength(40);
    await library.startImport(accountId, 3); await worker.processImport();
    list = await library.list(); expect(list.counts?.total).toBe(2); expect(list.jobs[0]?.imported).toBe(0);
  });
  it('enriches with a model and preserves unknown attributes; claims only once', async () => {
    await db.update(personaLibrary).set({ status: 'queued' });
    const worker = new PersonaLibraryWorker(db, fetch, async () => ({ enrichPersona: async () => ({ profile: { occupation: '研究员', occupationGroup: '专业技术人员', gender: null, ageBand: null, cityTier: null, incomeBand: null, traits: ['重视证据'], confidence: 0.9 }, parserVersion: 'fixture' }) }) as never);
    await Promise.all([worker.processEnrichment(), worker.processEnrichment()]);
    expect((await library.list()).counts?.ready).toBe(2);
    expect((await library.list()).rows[0]?.profile?.ageBand).toBeNull();
    expect(await worker.processEnrichment()).toBe(false);
  });
  it('samples shared assets into immutable per-survey snapshots with traceable assigned dimensions', async () => {
    const s = await service.create({ accountId, title: '共享人物', objective: '测试' });
    await service.updateQuestions({ accountId, surveyId: s.id, questions });
    const p = await service.createPool({ accountId, surveyId: s.id, spec: { segments }, sourceMode: 'persona_hub' });
    const rows = await db.select().from(personas).where(eq(personas.poolId, p.poolId));
    expect(rows).toHaveLength(10); expect(rows.every(r => r.source === 'persona_hub' && r.libraryId)).toBe(true);
    expect(rows[0]?.profile.description).toBeTruthy(); expect(rows[0]?.profile.ageBand).toBe('25-34');
    expect((rows[0]?.profile.provenance as { assignedDimensions: string[] }).assignedDimensions).toContain('ageBand');
    const d = await service.detail(accountId, s.id); expect(d.pool?.sourceStats.personaHub).toBe(10);
    await db.update(personaLibrary).set({ description: 'changed source' });
    expect((await db.select().from(personas).where(eq(personas.poolId, p.poolId)))[0]?.profile.description).not.toBe('changed source');
  });
  it('does not force incompatible demographics and hybrid fallback is explicit', async () => {
    const s = await service.create({ accountId, title: '缺口', objective: '测试' }); await service.updateQuestions({ accountId, surveyId: s.id, questions });
    const spec = { segments: [{ ...segments[0]!, occupationGroup: '学生' }] };
    await expect(service.createPool({ accountId, surveyId: s.id, spec, sourceMode: 'persona_hub' })).rejects.toMatchObject({ status: 409 });
    const p = await service.createPool({ accountId, surveyId: s.id, spec, sourceMode: 'hybrid' });
    expect((await service.detail(accountId, s.id)).pool?.sourceStats.generated).toBe(10);
    expect((await db.select().from(personas).where(eq(personas.poolId, p.poolId)))[0]?.source).toBe('generated');
  });
  it('failed import remains retryable and never stores arbitrary endpoint contents', async () => {
    await library.startImport(accountId, 3);
    await new PersonaLibraryWorker(db, (async () => new Response('not json')) as typeof fetch).processImport();
    expect((await library.list()).jobs[0]?.status).toBe('failed');
    await expect(library.startImport(accountId, -1)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects corrupt local mirrors and records a retryable error', async () => {
    const prior = process.env.PERSONA_HUB_DATA_FILE;
    process.env.PERSONA_HUB_DATA_FILE = new URL('./persona-calibration-e2e.test.ts', import.meta.url).pathname;
    try {
      await library.startImport(accountId, 1);
      await new PersonaLibraryWorker(db).processImport();
      expect((await library.list()).jobs[0]?.lastError).toContain('校验失败');
    } finally { if (prior === undefined) delete process.env.PERSONA_HUB_DATA_FILE; else process.env.PERSONA_HUB_DATA_FILE = prior; }
  });
});
describe('human calibration integration', () => {
  let id: number, poolId: number;
  beforeAll(async () => {
    const s = await service.create({ accountId, title: '校准调查', objective: '测试' }); id = s.id;
    await service.updateQuestions({ accountId, surveyId: id, questions });
    const p = await service.createPool({ accountId, surveyId: id, spec: { segments } }); poolId = p.poolId;
    const people = await db.select().from(personas).where(eq(personas.poolId, poolId)).orderBy(personas.id);
    await db.insert(surveyResponses).values(people.map((person, i) => ({ surveyId: id, personaId: person.id, answers: [{ questionId: 'q1', answer: i < 2 ? 'A' : 'B' }], status: 'completed', model: 'fixture', parserVersion: 'fixture' })));
    await db.update(surveys).set({ status: 'completed' }).where(eq(surveys.id, id));
  });
  it('applies bounded weights atomically, exposes benchmark and updates report', async () => {
    expect((await service.report(accountId, id)).questions[0]?.distribution[0]?.share).toBeCloseTo(0.2);
    const result = await calibration.calibrate(accountId, id, benchmark);
    expect(result?.applied).toBe(true); expect(result?.result.status).toBe('passed');
    const report = await service.report(accountId, id);
    expect(report.questions[0]?.distribution[0]?.share).toBeCloseTo(0.6, 2);
    expect(report.calibration?.benchmark.sampleSize).toBe(1000);
    expect(report.pool?.calibrationStatus).toBe('passed');
  });
  it('failed calibration leaves previously validated weights intact', async () => {
    const previous = await db.select({ weight: personas.weight }).from(personas).where(eq(personas.poolId, poolId)).orderBy(personas.id);
    const result = await calibration.calibrate(accountId, id, { ...benchmark, targets: [{ questionId: 'q1', shares: { A: 1, B: 0 } }] });
    expect(result?.applied).toBe(false);
    expect(await db.select({ weight: personas.weight }).from(personas).where(eq(personas.poolId, poolId)).orderBy(personas.id)).toEqual(previous);
    expect((await service.report(accountId, id)).pool?.calibrationStatus).toBe('passed');
    expect(await calibration.list(accountId, id)).toHaveLength(2);
  });
  it('rejects cross-tenant access, running survey and malformed real distributions', async () => {
    await expect(calibration.list(9999, id)).rejects.toMatchObject({ status: 404 });
    await expect(calibration.calibrate(9999, id, benchmark)).rejects.toMatchObject({ status: 404 });
    await expect(calibration.calibrate(accountId, id, {})).rejects.toMatchObject({ status: 400 });
    await db.update(surveys).set({ status: 'running' }).where(eq(surveys.id, id));
    await expect(calibration.calibrate(accountId, id, benchmark)).rejects.toMatchObject({ status: 409 });
    await db.update(surveys).set({ status: 'completed' }).where(eq(surveys.id, id));
  });
});
