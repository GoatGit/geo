#!/usr/bin/env node
/**
 * 超级问卷 HTTP 全链路 e2e(异步 worker 版)
 * 本地 LLM 桩 + 真实 API(dist) + 真实 SurveyWorker + 真实 Postgres;跑完自清理。
 * 用法: node scripts-dev/surveys-e2e-http.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DB_URL = 'postgres://geo:geo_dev@localhost:15432/geo';
const API = 'http://localhost:3000';
let failures = 0;

const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- LLM 桩 ----------
const SURVEY = {
  questions: [
    { id: 'q1', type: 'single', text: '购买新能源车时您最看重什么?', options: ['价格', '续航', '品牌', '智能座舱'] },
    { id: 'q2', type: 'single', text: '25万价位最合理的配置取向是?', options: ['长续航基础款', '性能版', '高配智能版', '均衡版'] },
    { id: 'q3', type: 'single', text: '您更倾向哪种购车方式?', options: ['全款', '贷款', '置换', '暂不购买'] },
    { id: 'q4', type: 'scale', text: '未来6个月内购买25万新能源SUV的可能性(1-10)' },
    { id: 'q5', type: 'open', text: '您对新能源SUV还有哪些顾虑?' },
  ],
  segments: [
    { ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '专业技术人员', count: 150 },
    { ageBand: '35-44', cityTier: '新一线', incomeBand: '30-50万', gender: '女', occupationGroup: '企业管理', count: 150 },
  ],
};
function startStub() {
  const stub = spawn(process.execPath, ['-e', `
    const http = require('http');
    const SURVEY = ${JSON.stringify(SURVEY)};
    http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rb = JSON.parse(body || '{}');
        const sys = rb.messages?.find((m) => m.role === 'system')?.content || '';
        let content = '{}';
        if (sys.includes('问卷设计器')) content = JSON.stringify(SURVEY);
        else if (sys.includes('虚拟人物')) {
          const quiz = JSON.parse(rb.messages.find((m) => m.role === 'user').content).问卷;
          content = JSON.stringify({ answers: quiz.map((q) =>
            q.type === 'single' ? { questionId: q.id, answer: q.options[0] }
            : q.type === 'scale' ? { questionId: q.id, answer: 7 }
            : q.type === 'multi' ? { questionId: q.id, answer: [q.options[0]] }
            : { questionId: q.id, answer: '担心的主要是充电便利性和保值率。' }) });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    }).listen(3100);
  `], { stdio: 'ignore' });
  return stub;
}

// ---------- 环境 ----------
function clearInsightRow() {
  execSync(`node ${path.join(ROOT, 'scripts-dev', 'configure-insight.js')} clear-db-row`, { stdio: 'pipe' });
}
const WORKER_ENV = {
  INSIGHT_AGENT_ENABLED: 'true',
  INSIGHT_AGENT_MODE: 'llm',
  INSIGHT_AGENT_ENDPOINT: 'http://127.0.0.1:3100/v1',
  INSIGHT_AGENT_API_KEY: 'stub',
  INSIGHT_AGENT_MODEL: 'qwen-flash',
  INSIGHT_AGENT_PROTOCOL: 'openai',
};

const children = [];
function startServer(cwd, logFile) {
  const child = spawn(process.execPath, ['--env-file=../../.env', 'dist/main.js'], {
    cwd,
    env: { ...process.env, ...WORKER_ENV },
    stdio: ['ignore', fsOpen(logFile), fsOpen(logFile)],
  });
  children.push(child);
  return child;
}
import fs from 'node:fs';
function fsOpen(file) { return fs.openSync(file, 'a'); }

async function waitHttp(url, ms = 15000) {
  for (let i = 0; i < ms / 300; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
}

async function api(method, p, token, body) {
  const r = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function pollStatus(token, surveyId, expect, maxSec) {
  const deadline = Date.now() + maxSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api('GET', `/surveys/${surveyId}`, token);
    last = r.json?.status;
    if (last === expect) return { ok: true, status: last };
    if (last === 'failed' || last === 'cancelled') return { ok: false, status: last, error: r.json?.lastError };
    await sleep(600);
  }
  return { ok: false, status: last, error: 'timeout' };
}

// ---------- 主流程 ----------
// 端口预清理:残留的旧 API 进程会让新请求落到旧路由上
try {
  const pids = execSync('lsof -tiTCP:3000 -sTCP:LISTEN').toString().trim();
  if (pids) { for (const pid of pids.split('\n')) process.kill(Number(pid)); console.log('killed stale 3000 listener:', pids); await sleep(500); }
} catch {}
clearInsightRow();
const stub = startStub();
await sleep(400);

startServer(path.join(ROOT, 'apps/api'), '/tmp/api-e2e.log');
startServer(path.join(ROOT, 'apps/worker-web'), '/tmp/worker-e2e.log');
ok(await waitHttp(API + '/health'), '1. API 启动');

// 登录(dev 验证码直显)
const codeRes = await (fetch(`${API}/auth/sms/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13900001111' }) }).then((r) => r.json()));
const token = await (fetch(`${API}/auth/sms/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13900001111', code: codeRes.devCode }) }).then((r) => r.json())).then((j) => j.accessToken || j.token);
ok(Boolean(token), '2. 登录(dev 短信通道)');

// 创建 + 生成
const created = await api('POST', '/surveys', token, { title: 'e2e新车调研', objective: '测试25万价位新能源SUV的购买意向与主要顾虑' });
ok(created.status === 201 || created.status === 200, '3. 创建调研草稿', `status=${created.status}`);
const sid = created.json.id;
const genRes = await api('POST', `/surveys/${sid}/generate`, token, {});
ok([200, 201, 202].includes(genRes.status), '4. 提交问卷生成任务', `status=${genRes.status} ${JSON.stringify(genRes.json).slice(0, 120)}`);
const gen = await pollStatus(token, sid, 'ready_selecting', 60);
ok(gen.ok, '5. worker 完成问卷生成 → ready_selecting', gen.status + (gen.error ? ' ' + gen.error : ''));
const sv = (await api('GET', `/surveys/${sid}`, token)).json;
ok(sv.questions?.length >= 5, '6. 问卷题目已写入', `${sv.questions?.length} 题`)

// 建池 + 闸门
const poolRes = await api('POST', `/surveys/${sid}/pools`, token, {
  surveyId: sid,
  segments: [
    { ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '专业技术人员', count: 3 },
    { ageBand: '35-44', cityTier: '新一线', incomeBand: '30-50万', gender: '女', occupationGroup: '企业管理', count: 3 },
  ],
});
const poolId = poolRes.json?.poolId ?? poolRes.json?.survey?.activePoolId;
ok(poolRes.status === 200 || poolRes.status === 201 || Boolean(poolId), '7. 创建人群池', `HTTP ${poolRes.status} body=${JSON.stringify(poolRes.json).slice(0, 100)}`);
const early = await api('POST', `/surveys/${sid}/run`, token, {});
ok(early.status === 409, '8. 未确认人群禁止运行(决策闸门)', `HTTP ${early.status}`);
const appr = await api('POST', `/surveys/${sid}/pools/${poolId}/approve`, token, { approved: true });
ok(appr.status === 200 || appr.status === 201, '9. 用户确认人群(approved)');

// 运行 + 报告
const runRes = await api('POST', `/surveys/${sid}/run`, token, {});
ok([200, 201, 202].includes(runRes.status), '10. 提交运行任务', `HTTP ${runRes.status}`);
const run = await pollStatus(token, sid, 'completed', 300);
ok(run.ok, '11. worker 完成 6 人作答 → completed', run.status + (run.error ? ' ' + run.error : ''));
const rep = (await api('GET', `/surveys/${sid}/report`, token)).json;
ok(Boolean(rep?.disclaimer?.includes('合成样本')), '12. 报告含合成样本声明');
ok(rep?.questions?.every((q) => q.question.type !== 'single' || Math.abs(q.distribution.reduce((s, d) => s + d.share, 0) - 1) < 1e-6), '13. 单选题分布归一化');
ok(rep?.questions?.some((q) => q.responses?.length > 0), '14. 开放题有原文回答');
console.log('    报告摘要:', rep?.questions?.map((q) => {
  const t = q.distribution?.filter((d) => d.share > 0).sort((a, b) => b.share - a.share)[0] ?? q.distribution?.[0];
  return `${q.question.text.slice(0, 16)} → ${t ? `${t.value} ${Math.round(t.share * 100)}%` : (q.responses[0] || '').slice(0, 24)}`;
}).join(' | '));

// 清理
for (const c of children) c.kill();
// 端口预清理:残留的旧 API 进程会让新请求落到旧路由上
try {
  const pids = execSync('lsof -tiTCP:3000 -sTCP:LISTEN').toString().trim();
  if (pids) { for (const pid of pids.split('\n')) process.kill(Number(pid)); console.log('killed stale 3000 listener:', pids); await sleep(500); }
} catch {}
clearInsightRow();
console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
