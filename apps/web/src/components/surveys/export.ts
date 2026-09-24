import type { SurveyReport } from './types';

/** Quote every CSV cell and neutralize spreadsheet formulas in user/model text. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function reportCsv(report: SurveyReport): string {
  const rows: unknown[][] = [
    ['调研', report.title], ['声明', report.disclaimer], ['目标', report.objective],
    ['有效样本', report.sampleSize, '计划样本', report.progress.total],
    ['原文范围', '开放题每题每组最多导出前 200 份原文；选项统计使用全部有效样本。'],
    ['题目', '题型', '分组', '有效N', '选项/原文', '人数', '加权占比', '量表均值'],
  ];
  if (report.calibration) {
    const c = report.calibration;
    rows.splice(5, 0, ['真人基准', c.benchmark.title, '来源', c.benchmark.source], ['真人样本', c.benchmark.sampleSize, '调查对象', c.benchmark.population, '日期', c.benchmark.collectedAt], ['校准方法', c.result.method, '有效样本量 ESS', c.result.effectiveSampleSize, '状态', c.applied ? '已应用' : '未应用']);
  }
  for (const q of report.questions) {
    for (const group of [{ ...q, label: '全部样本' }, ...q.groups]) {
      if (q.question.type === 'open') for (const answer of group.responses) rows.push([q.question.text, q.question.type, group.label, group.sampleSize, answer]);
      else for (const d of group.distribution) rows.push([q.question.text, q.question.type, group.label, group.sampleSize, d.value, d.count, `${(d.share * 100).toFixed(2)}%`, group.mean ?? '']);
    }
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function downloadReport(report: SurveyReport, format: 'csv' | 'json') {
  const content = format === 'csv' ? reportCsv(report) : JSON.stringify(report, null, 2);
  const blob = new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${report.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)}-合成样本报告.${format}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
