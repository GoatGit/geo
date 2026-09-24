/** Real HTTP + PostgreSQL + worker + Chrome audit. Only the external LLM is a deterministic HTTP fixture.
 * Run after building workspace packages/API/worker: node apps/worker-web/scripts/surveys-browser-audit.mjs
 * Uses isolated DB schema, web copy and ports; never loads .env or changes stored platform settings.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const workerRequire = createRequire(resolve(root, 'apps/worker-web/package.json'));
const { Pool } = apiRequire('pg');
const { createDb, runMigrations, accounts, personaLibrary } = apiRequire('@geo/db');
const jwt = apiRequire('jsonwebtoken');
const { chromium } = workerRequire('playwright-core');
const artifact = process.env.SURVEY_ARTIFACT_DIR ?? await mkdtemp(resolve(tmpdir(), 'geo-surveys-browser-'));
await mkdir(artifact, { recursive: true });
const schema = `survey_browser_${randomUUID().replaceAll('-', '')}`;
const baseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://geo:geo_dev@localhost:15432/geo';
const dbUrl = new URL(baseUrl); dbUrl.searchParams.set('options', `-c search_path=${schema}`);
const secret = randomUUID(), children = [], pageErrors = [];
let browser, dbPool, fixture, page;
const admin = new Pool({ connectionString: baseUrl });
const apiPort = Number(process.env.SURVEY_API_PORT ?? 3210), webPort = Number(process.env.SURVEY_WEB_PORT ?? 3211);
const apiOrigin = `http://127.0.0.1:${apiPort}`, webOrigin = `http://127.0.0.1:${webPort}`;
const webDir = await mkdtemp(resolve(tmpdir(), 'geo-surveys-web-'));
const state = { invalidGeneration: false, failPerson: true, answers: 0, generation: 0, delay: 200 };
const questions = [
  { id: 'q1', type: 'single', text: '最看重哪一项？', options: ['价格', '品质', '服务', '其他'] },
  { id: 'q2', type: 'multi', text: '哪些因素影响选择？', options: ['价格', '口碑', '服务', '其他'] },
  { id: 'q3', type: 'scale', text: '购买意愿（1 为最低，10 为最高）' },
  { id: 'q4', type: 'open', text: '还有哪些顾虑？' },
  { id: 'q5', type: 'single', text: '是否愿意尝试？', options: ['愿意', '观望', '不愿意', '不确定'] },
];
const segments = ['男', '女'].map(gender => ({ gender, ageBand: '25-34', cityTier: '二线', incomeBand: '10-20万', occupationGroup: '企业职员', count: 4 }));
function launch(name, command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(resolve(artifact, `${name}.log`)); child.stdout.pipe(log); child.stderr.pipe(log);
  children.push(child); return child;
}
async function waitFor(fn, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await new Promise(r => setTimeout(r, 250)); }
  throw Error(`Timed out: ${label}`);
}
let token, otherToken;
async function request(path, body, expected = 200, auth = token) {
  if (body?.surveyId && /^\/surveys:(generate|questions|pools|pools:approve|run)$/.test(path)) {
    const { surveyId, poolId, ...payload } = body;
    path = path === '/surveys:pools:approve' ? `/surveys/${surveyId}/pools/${poolId}/approve` : `/surveys/${surveyId}/${path.slice('/surveys:'.length)}`; body = payload;
  }
  const res = await fetch(apiOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(json)}`); return json;
}
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 60000 }); }
try {
  await admin.query(`create schema ${schema}`);
  const created = createDb(dbUrl.toString()); dbPool = created.pool;
  await runMigrations(dbPool);
  const owners = await created.db.insert(accounts).values([{ phone: '13911112222' }, { phone: '13911113333' }]).returning();
  token = jwt.sign({ accountId: owners[0].id, phone: owners[0].phone }, secret, { expiresIn: '1h' });
  const adminToken = jwt.sign({ accountId: owners[0].id, phone: owners[0].phone, role: 'admin' }, secret, { expiresIn: '1h' });
  otherToken = jwt.sign({ accountId: owners[1].id, phone: owners[1].phone }, secret, { expiresIn: '1h' });
  fixture = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), system = body.messages?.find(m => m.role === 'system')?.content ?? '';
      let value = {};
      if (system.includes('问卷设计器')) { state.generation++; value = state.invalidGeneration ? {} : { questions, segments }; }
      else if (system.includes('虚拟人物')) {
        state.answers++;
        const input = JSON.parse(body.messages.find(m => m.role === 'user').content);
        const profile = input.档案;
        const failed = state.failPerson && profile.sampleKey === '1-1';
        value = failed ? {} : { answers: input.问卷.map(q => ({ questionId: q.id, answer: q.type === 'single' ? q.options[profile.gender === '男' ? 0 : 1] : q.type === 'multi' ? q.options.slice(0, 2) : q.type === 'scale' ? 7 : `关注售后与体验，样本 ${profile.sampleKey}` })) };
      }
      await new Promise(r => setTimeout(r, state.delay));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const env = { NODE_ENV: 'test', PORT: String(apiPort), DATABASE_URL: dbUrl.toString(), REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:16379/14', JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: randomUUID(), PUBLIC_BASE_URL: '', AUTO_MIGRATE: '0', INSIGHT_AGENT_ENABLED: 'true', INSIGHT_AGENT_MODE: 'llm', INSIGHT_AGENT_ENDPOINT: `http://127.0.0.1:${fixture.address().port}/v1`, INSIGHT_AGENT_API_KEY: 'local-fixture', INSIGHT_AGENT_MODEL: 'survey-audit', INSIGHT_AGENT_PROTOCOL: 'openai' };
  launch('api', process.execPath, ['apps/api/dist/main.js'], env);
  await waitFor(async () => { try { return (await fetch(apiOrigin + '/surveys')).status === 401; } catch { return false; } }, 'API startup');
  launch('worker', process.execPath, ['-e', `const {createDb}=require('@geo/db'); const {SurveyWorker}=require('./dist/survey-worker'); const {db,pool}=createDb(process.env.DATABASE_URL);const worker=new SurveyWorker(db).start();process.on('SIGTERM',async()=>{await worker.stop();await pool.end();process.exit(0)});`], env, resolve(root, 'apps/worker-web'));
  await request('/persona-library/imports', { count: 5 }, 403);
  await request('/persona-library/enrich', { count: -1 }, 400, adminToken);
  await created.db.insert(personaLibrary).values({ sourceKey: 'browser-fixture', description: 'An engineer who values reliability', sourceUrl: 'https://github.com/tencent-ailab/persona-hub', sourceRevision: 'test-revision', license: 'CC-BY-NC-SA-4.0', status: 'ready', profile: { occupationGroup: '企业职员', traits: ['重视可靠性'], confidence: 0.9 } });
  await request('/surveys', undefined, 401, null);
  await request('/surveys', { title: ' ', objective: ' ' }, 400);
  const manual = await request('/surveys', { title: 'HTTP 路由回归', objective: '验证真实路由及校验' }, 201);
  await request('/surveys:questions', { surveyId: manual.id, questions }, 201);
  assert.equal((await request(`/surveys/${manual.id}`)).questions.length, 5);
  assert.equal(state.generation, 0, 'saving questions must not invoke generation route');
  await request('/surveys:questions', { surveyId: manual.id, questions: [null] }, 400);
  await request('/surveys:pools', { surveyId: manual.id, segments: [{ ...segments[0], count: 1.5 }] }, 400);
  await request('/surveys:pools:approve', { surveyId: manual.id, poolId: 1, approved: 'true' }, 400);
  await request('/surveys:run', { surveyId: manual.id }, 409);
  await request(`/surveys/${manual.id}`, undefined, 404, otherToken);
  await request('/surveys:questions', { surveyId: manual.id, questions }, 404, otherToken);
  await request('/surveys:bogus', { surveyId: manual.id }, 404);
  console.log('PASS HTTP auth, tenant boundaries, distinct action routes and DTO validation');
  for (const name of ['src', 'public', 'package.json', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.mjs', 'next-env.d.ts', 'next.config.mjs']) {
    await cp(resolve(root, 'apps/web', name), resolve(webDir, name), { recursive: true }).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  // The app's tsconfig extends the repo root configuration.
  const { readFile } = await import('node:fs/promises');
  const tsconfig = JSON.parse(await readFile(resolve(webDir, 'tsconfig.json'), 'utf8'));
  if (tsconfig.extends) tsconfig.extends = resolve(root, 'tsconfig.base.json'); await writeFile(resolve(webDir, 'tsconfig.json'), JSON.stringify(tsconfig));
  await symlink(resolve(root, 'apps/web/node_modules'), resolve(webDir, 'node_modules'));
  const productionWeb = process.env.SURVEY_WEB_PRODUCTION === '1';
  if (productionWeb) {
    const build = launch('web-build', process.execPath, [webRequire.resolve('next/dist/bin/next'), 'build', webDir], { NODE_ENV: 'production', API_ORIGIN: apiOrigin }, webDir);
    assert.equal((await once(build, 'exit'))[0], 0, 'production web build');
  }
  launch('web', process.execPath, [webRequire.resolve('next/dist/bin/next'), productionWeb ? 'start' : 'dev', webDir, '-p', String(webPort), '-H', '127.0.0.1'], { NODE_ENV: productionWeb ? 'production' : 'development', API_ORIGIN: apiOrigin }, webDir);
  await waitFor(async () => { try { return (await fetch(webOrigin + '/surveys')).ok; } catch { return false; } }, 'web startup', 90000);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await context.addInitScript(({ token, owner }) => { localStorage.setItem('geo.accessToken', token); localStorage.setItem('geo.account', JSON.stringify({ accountId: owner.id, phone: owner.phone, role: 'user' })); }, { token, owner: owners[0] });
  page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(webOrigin + '/surveys/pools'); await visible(page.getByText('Persona Hub 共享档案')); await visible(page.getByText('An engineer who values reliability')); await page.getByRole('button', { name: '调研人群方案', exact: true }).click(); await visible(page.getByText('还没有人群方案'));
  await page.goto(webOrigin + '/surveys/reports'); await visible(page.getByText('这份调研还没有有效回答'));
  await page.goto(webOrigin + '/surveys/new'); await page.getByLabel('调研标题').fill('咖啡机需求探索 · 浏览器验收'); await page.getByLabel('调研目标').fill('了解便携咖啡机用户的需求、价格接受度和购买顾虑。');
  await page.getByRole('button', { name: '创建调研 →' }).click(); await page.waitForURL(/\/surveys\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  state.invalidGeneration = true;
  await page.getByRole('button', { name: 'AI 生成问卷', exact: true }).click();
  await visible(page.getByText('AI 未返回有效问卷', { exact: false }));
  state.invalidGeneration = false;
  await page.getByRole('button', { name: 'AI 生成问卷', exact: true }).click();
  await visible(page.getByLabel('第 1 题题目'));
  assert.equal((await request('/surveys')).length, 2, 'generation retry must reuse the same draft');
  await page.getByLabel('第 1 题题目').fill('你最在意便携咖啡机的哪一项？');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: '← 全部调研' }).click();
  assert.ok(page.url().endsWith(`/surveys/${id}`), 'unsaved navigation can be cancelled');
  await page.getByLabel('第 1 题选项 1', { exact: true }).fill('合理价格');
  await page.getByRole('button', { name: '＋ 添加问题', exact: true }).click();
  await page.getByLabel('第 6 题题型').selectOption('open'); await page.getByLabel('第 6 题题目').fill('你希望改进什么？');
  await page.getByRole('button', { name: '上移第 6 题', exact: true }).click();
  await page.getByRole('button', { name: '删除第 6 题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile editor must not overflow');
  await page.screenshot({ path: resolve(artifact, '06-editor-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: resolve(artifact, '01-question-editor.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '保存问卷，选择人群 →' }).click();
  await visible(page.getByLabel('人群 1 样本量')); await page.reload(); await visible(page.getByLabel('人群 1 样本量'));
  const saved = await request(`/surveys/${id}`); assert.equal(saved.questions[0].text, '你最在意便携咖啡机的哪一项？'); assert.equal(saved.questions[0].options[0], '合理价格'); assert.equal(saved.questions[4].text, '你希望改进什么？');
  await page.getByLabel('人物来源').selectOption('persona_hub');
  await page.getByLabel('人群 1 样本量').fill('4'); await page.getByLabel('人群 2 样本量').fill('4');
  await page.getByRole('button', { name: '保存人群方案' }).click(); await visible(page.getByRole('button', { name: '确认使用此人群' }));
  await page.getByRole('button', { name: '确认使用此人群' }).click(); await page.getByRole('button', { name: '查看运行计划 →' }).click();
  await page.getByRole('button', { name: '确认开始作答' }).click();
  await page.goto(webOrigin + '/surveys'); await page.reload();
  await waitFor(async () => (await request(`/surveys/${id}`)).status === 'partial', 'partial result');
  await page.goto(webOrigin + `/surveys/${id}`); await visible(page.getByRole('button', { name: '补跑缺失样本' }));
  assert.equal(state.answers, 8); state.failPerson = false;
  await page.getByRole('button', { name: '补跑缺失样本' }).click(); await visible(page.getByRole('link', { name: '查看完整报告 →' }));
  assert.equal(state.answers, 9, 'retry only failed sample');
  const selectedPool = (await request(`/surveys/${id}`)).pool;
  assert.equal(selectedPool.sourceMode, 'persona_hub'); assert.equal(selectedPool.sourceStats.personaHub, 8);
  assert.equal(selectedPool.sourceStats.generated, 0);
  await page.getByRole('link', { name: '查看完整报告 →' }).click();
  await visible(page.getByText('样本完成率')); await page.getByLabel('分组对比', { exact: true }).selectOption('gender');
  await visible(page.getByRole('columnheader', { name: '分组 / 有效 N' }).first());
  const report = await request(`/surveys/${id}/report?dimension=gender`);
  assert.equal(report.sampleSize, 8); assert.equal(report.questions[1].distribution[0].share, 1); assert.equal(report.questions[1].distribution[1].share, 1); assert.equal(report.questions[2].mean, 7); assert.equal(report.questions[0].groups.length, 2);
  await page.getByLabel('基准名称', { exact: true }).fill('浏览器校准基准');
  await page.getByLabel('真人数据来源').fill('https://example.org/browser-fixture');
  await page.getByLabel('真人调查对象').fill('测试汇总数据，非真实研究结论');
  await page.getByLabel('真人调查日期').fill('2026-09-01');
  await page.getByLabel('真人有效样本量').fill('1000');
  await page.getByRole('button', { name: '导入真人回答 CSV' }).click();
  await page.getByLabel('真人回答 CSV').setInputFiles({ name: 'human.csv', mimeType: 'text/csv', buffer: Buffer.from('q1\n合理价格\n合理价格\n合理价格\n品质\n品质\n') });
  await waitFor(async () => await page.getByRole('button', { name: '计算并应用校准' }).isEnabled(), 'valid CSV ready');
  await page.getByLabel('真人回答 CSV').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('q1\n不存在的选项\n') });
  await visible(page.getByRole('alert').filter({ hasText: '不属于题目选项' }));
  assert.equal(await page.getByRole('button', { name: '计算并应用校准' }).isEnabled(), false, 'invalid CSV must block applying stale targets');
  assert.equal(await page.getByLabel('真人有效样本量').inputValue(), '', 'failed CSV clears prior sample size');
  await page.getByLabel('真人回答 CSV').setInputFiles({ name: 'human.csv', mimeType: 'text/csv', buffer: Buffer.from('q1\n合理价格\n合理价格\n合理价格\n品质\n品质\n') });
  await page.getByRole('button', { name: '计算并应用校准' }).click();
  await visible(page.getByText('浏览器校准基准 · 已应用').first());
  const calibrated = await request(`/surveys/${id}/report`);
  assert.ok(Math.abs(calibrated.questions[0].distribution[0].share - 0.6) < 0.01);
  assert.equal(calibrated.calibration.benchmark.sampleSize, 5);
  await request(`/surveys/${id}/calibrations`, undefined, 404, otherToken);
  await request(`/surveys/${id}/calibrations`, {}, 404, otherToken);
  await page.screenshot({ path: resolve(artifact, '02-report-desktop.png'), fullPage: true, animations: 'disabled' });
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 CSV' }).click(); const download = await downloadPromise; await download.saveAs(resolve(artifact, 'report.csv'));
  const csv = await readFile(resolve(artifact, 'report.csv'), 'utf8'); assert.ok(csv.includes('合成样本')); assert.ok(csv.includes('合理价格'));
  await page.goto(webOrigin + '/surveys/reports'); await visible(page.getByText('样本完成率'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(artifact, '03-report-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile report must not overflow');
  await page.goto(webOrigin + '/surveys/pools'); await page.getByRole('button', { name: '调研人群方案', exact: true }).click(); await visible(page.getByText('人群方案 #', { exact: false })); await page.screenshot({ path: resolve(artifact, '04-pools-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile pools must not overflow');
  await page.goto(webOrigin + '/surveys/new'); await visible(page.getByLabel('调研标题')); await page.screenshot({ path: resolve(artifact, '05-new-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'mobile form must not overflow');
  // Cancellation through real API while the actual worker has an in-flight completion.
  const pool = await request('/surveys:pools', { surveyId: manual.id, segments: [{ ...segments[0], count: 3 }] }, 201);
  await request('/surveys:pools:approve', { surveyId: manual.id, poolId: pool.poolId, approved: true }, 201);
  state.delay = 1200; const before = state.answers;
  await request('/surveys:run', { surveyId: manual.id }, 202);
  await waitFor(async () => state.answers > before, 'worker starts');
  await request(`/surveys/${manual.id}/cancel`, {}, 201);
  await new Promise(r => setTimeout(r, 1500));
  const cancelled = await request(`/surveys/${manual.id}`); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.progress.completed, 0);
  await request(`/surveys/${id}/report`, undefined, 404, otherToken);
  assert.deepEqual(await request('/surveys-pools', undefined, 200, otherToken), []);
  assert.equal((await request('/surveys-pools')).length, 2);
  await request('/surveys:questions', { surveyId: id, questions }, 409);
  // Switching between cached reports must not carry calibration data across surveys.
  const second = await request('/surveys', { title: '另一份校准问卷', objective: '校准表单隔离测试' }, 201);
  await request(`/surveys/${second.id}/questions`, { questions: saved.questions }, 201);
  const secondPool = await request(`/surveys/${second.id}/pools`, { segments: [{ ...segments[0], count: 5 }] }, 201);
  await request(`/surveys/${second.id}/pools/${secondPool.poolId}/approve`, { approved: true }, 201);
  state.delay = 50;
  await request(`/surveys/${second.id}/run`, {}, 202);
  await waitFor(async () => (await request(`/surveys/${second.id}`)).status === 'completed', 'second report ready');
  await page.goto(webOrigin + `/surveys/reports?surveyId=${id}`);
  await visible(page.getByLabel('基准名称', { exact: true }));
  await page.getByLabel('选择调研', { exact: true }).selectOption(String(second.id));
  await visible(page.getByRole('heading', { name: '另一份校准问卷', exact: true }));
  await page.getByLabel('基准名称', { exact: true }).fill('不应留给其他问卷的基准');
  await page.getByLabel('选择调研', { exact: true }).selectOption(String(id));
  await visible(page.getByRole('heading', { name: '咖啡机需求探索 · 浏览器验收', exact: true }));
  assert.equal(await page.getByLabel('基准名称', { exact: true }).inputValue(), '', 'cached report switch resets calibration form');
  assert.equal(await page.getByLabel('真人有效样本量').inputValue(), '');
  assert.deepEqual(pageErrors, []);
  await rm(resolve(artifact, 'failure.png'), { force: true });
  await writeFile(resolve(artifact, 'result.json'), JSON.stringify({ passed: true, http: 'real Nest API', database: 'isolated PostgreSQL schema', worker: 'actual SurveyWorker', llm: 'deterministic local HTTP fixture', checks: ['route matching', 'DTO validation', 'tenant boundaries', 'brandless entry', 'generation failure and retry', 'edit-save-reload', 'pool confirmation', 'background progress', 'partial-only retry', 'cancel fencing', 'report default selection', 'multi-select aggregation', 'dimension comparison', 'CSV download', 'mobile overflow', 'browser errors', 'Persona Hub sampling', 'CSV benchmark calibration', 'invalid CSV clears stale targets', 'calibration state isolated between cached reports', 'calibration tenant boundaries', 'library admin authorization'], screenshots: 6 }, null, 2));
  console.log(`PASS browser and HTTP full lifecycle. Evidence: ${artifact}`);
} catch (error) {
  if (page) await page.screenshot({ path: resolve(artifact, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => undefined);
  console.error(`FAIL. Evidence: ${artifact}`); throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue; child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (fixture) await new Promise(r => fixture.close(r));
  await dbPool?.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  await rm(webDir, { recursive: true, force: true });
}
