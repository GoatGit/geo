import { describe, expect, it } from 'vitest';
import { validateSurveyQuestions, validateSurveySegments, aggregateSurvey } from '../src/surveys';

const questions = [
  { id: 'q1', type: 'multi' as const, text: '看重哪些因素？', options: ['价格', '续航', '品牌'] },
  { id: 'q2', type: 'scale' as const, text: '购买意愿（1低—10高）' },
  { id: 'q3', type: 'open' as const, text: '还有哪些顾虑？' },
];
const segment = { ageBand: '25-34', cityTier: '一线', incomeBand: '10-20万', gender: '不限', occupationGroup: '专业技术人员', count: 10 };

describe('survey input contracts', () => {
  it.each([[], [{ ...questions[0], options: ['A', ' A '] }], [questions[0], questions[0]], [{ ...questions[0], id: '__proto__' }], [{ ...questions[0], text: ' ' }]])('rejects malformed question definitions', (input) => {
    expect(validateSurveyQuestions(input).ok).toBe(false);
  });
  it('normalizes valid inputs without losing question types', () => {
    const result = validateSurveyQuestions(questions);
    expect(result).toEqual({ ok: true, value: questions });
  });
  it.each([-1, 0, 1.5, Infinity, 2001])('rejects invalid per-segment count %s', (count) => {
    expect(validateSurveySegments([{ ...segment, count }]).ok).toBe(false);
  });
  it('caps the total instead of silently clamping individual groups', () => {
    expect(validateSurveySegments([{ ...segment, count: 1500 }, { ...segment, count: 1000 }]).ok).toBe(false);
    expect(validateSurveySegments([{ ...segment, ageBand: '' }]).ok).toBe(false);
    expect(validateSurveySegments(null).ok).toBe(false);
  });
});

describe('survey report accounting', () => {
  it('counts multi-select choices per respondent, includes zeroes and computes weighted scale means', () => {
    const result = aggregateSurvey(questions, [
      { weight: 2, profile: { gender: '女' }, answers: [{ questionId: 'q1', answer: ['价格', '续航'] }, { questionId: 'q2', answer: 8 }, { questionId: 'q3', answer: '担心售后' }] },
      { weight: 1, profile: { gender: '男' }, answers: [{ questionId: 'q1', answer: ['价格'] }, { questionId: 'q2', answer: 2 }, { questionId: 'q3', answer: '担心价格' }] },
    ], 'gender');
    expect(result.questions[0].distribution).toEqual([
      { value: '价格', share: 1, count: 2, weightedCount: 3 },
      { value: '续航', share: 2 / 3, count: 1, weightedCount: 2 },
      { value: '品牌', share: 0, count: 0, weightedCount: 0 },
    ]);
    expect(result.questions[1].mean).toBe(6);
    expect(result.questions[0].responses).toEqual([]);
    expect(result.questions[2].responses).toEqual(['担心售后', '担心价格']);
    expect(result.questions[0].groups.find(g => g.label === '女')?.sampleSize).toBe(1);
  });
  it('does not count duplicate choices twice or use invalid weights', () => {
    const result = aggregateSurvey(questions, [
      { weight: 1, profile: {}, answers: [{ questionId: 'q1', answer: ['价格', '价格'] }] },
      { weight: -2, profile: {}, answers: [{ questionId: 'q1', answer: ['价格'] }] },
    ]);
    expect(result.questions[0].distribution[0].share).toBe(1);
    expect(result.questions[0].sampleSize).toBe(1);
  });
});
