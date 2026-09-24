import { describe, expect, it } from 'vitest';
import { InsightAgent } from '../src/index';
import { DEFAULT_INSIGHT_AGENT_SETTINGS } from '@geo/shared';
import {
  validatePersonaAnswerOutput,
  validatePersonaEnrichOutput,
  validateSurveyGenOutput,
} from '../src/schema';

const QUESTIONS = [
  { id: 'q1', type: 'single', text: '最看重什么?', options: ['价格', '续航', '品牌', '智能'] },
  { id: 'q2', type: 'multi', text: '担心什么?', options: ['保值率', '充电', '售后', '安全'] },
  { id: 'q3', type: 'scale', text: '购买意向 1-10' },
  { id: 'q4', type: 'open', text: '还有什么顾虑?' },
];

it('长问卷有足够的输出预算，并记录问卷专用提示词版本', async () => {
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: `q${i + 1}`, type: 'open', text: `顾虑 ${i + 1}` }));
  let budget = 0;
  const agent = new InsightAgent({ settings: { ...DEFAULT_INSIGHT_AGENT_SETTINGS, enabled: true, mode: 'llm', endpoint: 'https://example.com/v1', apiKey: 'test', model: 'fixture' }, fetchImpl: (async (_url, init) => {
    budget = JSON.parse(String(init?.body)).max_tokens;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: questions.map(q => ({ questionId: q.id, answer: '担心售后体验' })) }) } }] }));
  }) as typeof fetch });
  const result = await agent.personaAnswer({ profile: {}, questions });
  expect(result?.answers).toHaveLength(20);
  expect(budget).toBeGreaterThan(7000);
  expect(result?.parserVersion).toContain('survey-s2');
});

describe('validateSurveyGenOutput', () => {
  it('拒绝题目数量不足', () => {
    const r = validateSurveyGenOutput({
      questions: [{ id: 'q1', type: 'single', text: '题', options: ['a', 'b', 'c', 'd'] }],
      segments: [{ ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '企业管理', count: 100 }],
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝对勾选题型缺失选项/选项越界', () => {
    const r = validateSurveyGenOutput({
      questions: [
        { id: 'q1', type: 'single', text: '题', options: ['a', 'a'] },
        { id: 'q2', type: 'single', text: '题', options: ['a', 'b', 'c', 'd'] },
        { id: 'q3', type: 'scale', text: '题' },
        { id: 'q4', type: 'scale', text: '题' },
        { id: 'q5', type: 'scale', text: '题' },
      ],
      segments: [{ ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '企业管理', count: 100 }],
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝超样本数，不能静默改动建议配额', () => {
    const qs = [1, 2, 3, 4, 5].map((i) => ({ id: `q${i}`, type: 'scale', text: `题${i}` }));
    const r = validateSurveyGenOutput({
      questions: qs,
      segments: [{ ageBand: '25-34', cityTier: '一线', incomeBand: '20-30万', gender: '男', occupationGroup: '企业管理', count: 9999 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('validatePersonaAnswerOutput', () => {
  const valid = [
    { questionId: 'q1', answer: '价格' }, { questionId: 'q2', answer: ['充电', '安全', '售后'] },
    { questionId: 'q3', answer: 7 }, { questionId: 'q4', answer: '希望售后可靠' },
  ];
  it('接受三个多选项，并拒绝重复题、额外题及空/重复勾选', () => {
    expect(validatePersonaAnswerOutput({ answers: valid }, { questions: QUESTIONS }).ok).toBe(true);
    for (const answers of [
      [...valid, valid[0]], [...valid, { questionId: 'unknown', answer: 'x' }],
      valid.map(a => a.questionId === 'q2' ? { ...a, answer: [] } : a),
      valid.map(a => a.questionId === 'q2' ? { ...a, answer: ['充电', '充电'] } : a),
    ]) expect(validatePersonaAnswerOutput({ answers }, { questions: QUESTIONS }).ok).toBe(false);
  });
  it('丢弃幻觉题并拒绝未答满', () => {
    const r = validatePersonaAnswerOutput(
      { answers: [{ questionId: 'ghost', answer: 'x' }, { questionId: 'q1', answer: '价格' }] },
      { questions: QUESTIONS },
    );
    expect(r.ok).toBe(false);
  });

  it('单选越权选项拒收', () => {
    const r = validatePersonaAnswerOutput(
      {
        answers: [
          { questionId: 'q1', answer: '不差钱' },
          { questionId: 'q2', answer: ['充电'] },
          { questionId: 'q3', answer: 7 },
          { questionId: 'q4', answer: '怕售后贵' },
        ],
      },
      { questions: QUESTIONS },
    );
    expect(r.ok).toBe(false);
  });

  it('量表越界拒收;合法全卷通过且顺序无关', () => {
    const bad = validatePersonaAnswerOutput(
      {
        answers: [
          { questionId: 'q1', answer: '价格' },
          { questionId: 'q2', answer: ['充电', '安全'] },
          { questionId: 'q3', answer: 11 },
          { questionId: 'q4', answer: '怕售后贵' },
        ],
      },
      { questions: QUESTIONS },
    );
    expect(bad.ok).toBe(false);
    const good = validatePersonaAnswerOutput(
      {
        answers: [
          { questionId: 'q4', answer: '怕售后贵' },
          { questionId: 'q2', answer: ['充电'] },
          { questionId: 'q3', answer: 7 },
          { questionId: 'q1', answer: '续航' },
        ],
      },
      { questions: QUESTIONS },
    );
    expect(good.ok).toBe(true);
  });
});

describe('validatePersonaEnrichOutput', () => {
  it('null 字段合法(原文无依据不猜测)', () => {
    const r = validatePersonaEnrichOutput({
      occupation: '数据科学教授',
      occupationGroup: '专业技术人员',
      ageBand: null,
      cityTier: null,
      incomeBand: null,
      gender: null,
      traits: ['理性'],
      confidence: 0.5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ageBand).toBeNull();
  });

  it('traits 过滤非字符串并截断', () => {
    const r = validatePersonaEnrichOutput({
      occupation: null,
      occupationGroup: null,
      ageBand: null,
      cityTier: null,
      incomeBand: null,
      gender: null,
      traits: ['a', 3, '', ...Array.from({ length: 10 }, (_, i) => `t${i}`)],
      confidence: 2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.traits.every((t) => typeof t === 'string' && t)).toBe(true);
      expect(r.value.traits.length).toBeLessThanOrEqual(8);
      expect(r.value.confidence).toBe(0);
    }
  });
});
