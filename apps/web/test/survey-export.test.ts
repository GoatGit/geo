import { describe, expect, it } from 'vitest';
import { csvCell, reportCsv } from '../src/components/surveys/export';
import type { SurveyReport } from '../src/components/surveys/types';

describe('survey report export', () => {
  it('neutralizes formula injection and escapes quotes/newlines without destroying Chinese text', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-1+2', '@SUM(1)', ' \t=cmd()', '\r=1']) expect(csvCell(value)).toBe(`"'${value}"`);
    expect(csvCell('中文,"原文"\n下一行')).toBe('"中文,""原文""\n下一行"');
    expect(csvCell('正常回答')).toBe('"正常回答"');
  });
  it('exports denominators, disclaimer, groups and zero choices', () => {
    const report = { title: '需求调研', disclaimer: '合成样本', objective: '探索', sampleSize: 2, progress: { total: 3 }, questions: [{ question: { text: '买哪个', type: 'single' }, sampleSize: 2, distribution: [{ value: 'A', count: 2, share: 1 }, { value: 'B', count: 0, share: 0 }], mean: null, groups: [{ label: '男', sampleSize: 1, distribution: [{ value: 'A', count: 1, share: 1 }], mean: null }] }] } as unknown as SurveyReport;
    const csv = reportCsv(report);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"声明","合成样本"');
    expect(csv).toContain('"有效样本","2","计划样本","3"');
    expect(csv).toContain('"全部样本","2","B","0","0.00%"');
    expect(csv).toContain('"男","1","A","1","100.00%"');
  });
});
