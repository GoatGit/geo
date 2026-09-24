import { describe, expect, it } from 'vitest';
import { calibrateWeights, validateCalibrationInput, parseHumanCsv } from '../src/calibration';
const questions = [{ id: 'q1', type: 'single' as const, text: '选择', options: ['A', 'B'] }, { id: 'q2', type: 'single' as const, text: '倾向', options: ['是', '否'] }];
const input = { title: '真人调查', source: 'https://example.org/poll', population: '调查参与者', sampleSize: 1000, collectedAt: '2026-09-01', targets: [{ questionId: 'q1', shares: { A: 0.6, B: 0.4 } }] };
const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, answers: [{ questionId: 'q1', answer: i < 2 ? 'A' : 'B' }, { questionId: 'q2', answer: i < 5 ? '是' : '否' }] }));
describe('human benchmark validation', () => {
  it('requires real-source metadata and matching exclusive choice distributions', () => {
    expect(validateCalibrationInput(input, questions).ok).toBe(true);
    for (const bad of [{ ...input, source: '' }, { ...input, sampleSize: 0 }, { ...input, targets: [{ questionId: 'ghost', shares: { A: 1 } }] }, { ...input, targets: [{ questionId: 'q1', shares: { A: 0.9 } }] }, { ...input, targets: [{ questionId: 'q1', shares: { A: 0.8, B: 0.8 } }] }]) expect(validateCalibrationInput(bad, questions).ok).toBe(false);
    expect(validateCalibrationInput(input, [{ ...questions[0], type: 'multi' }]).ok).toBe(false);
  });
  it('parses quoted CSV, ignores identifier columns, and rejects invalid responses', () => {
    expect(parseHumanCsv('\uFEFFrespondent,q1,q2\r\n"one, first",A,是\r\n2,B,否\r\n', questions)).toEqual({ sampleSize: 2, targets: [{ questionId: 'q1', shares: { A: 0.5, B: 0.5 } }, { questionId: 'q2', shares: { 是: 0.5, 否: 0.5 } }] });
    expect(() => parseHumanCsv('q1\n未知\n', questions)).toThrow();
    expect(() => parseHumanCsv('q1,q1\nA,B\n', questions)).toThrow();
  });
});
describe('bounded raking of synthetic responses', () => {
  it('fits known marginals while preserving sample scale and reporting ESS', () => {
    const result = calibrateWeights(rows, input.targets);
    expect(result.status).toBe('passed');
    expect(result.before[0].maxDeviation).toBeCloseTo(0.4);
    expect(result.after[0].maxDeviation).toBeLessThan(0.01);
    expect(result.weights.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(10);
    expect(result.effectiveSampleSize).toBeLessThan(10);
    expect(result.weights.every(r => r.weight >= 0.05 && r.weight <= 20)).toBe(true);
  });
  it('refuses missing support and does not manufacture population coverage', () => {
    const result = calibrateWeights(rows.filter(r => r.id > 2), input.targets);
    expect(result.status).toBe('failed');
    expect(result.warnings.join('')).toContain('A');
  });
  it('does not pass incompatible marginals or a tiny effective sample', () => {
    const correlated = rows.map(r => ({ ...r, answers: [{ questionId: 'q1', answer: r.id < 3 ? 'A' : 'B' }, { questionId: 'q2', answer: r.id < 3 ? '是' : '否' }] }));
    expect(calibrateWeights(correlated, [...input.targets, { questionId: 'q2', shares: { 是: 0.1, 否: 0.9 } }]).status).toBe('failed');
    expect(calibrateWeights(rows.slice(0, 1), input.targets).status).toBe('failed');
  });
});
