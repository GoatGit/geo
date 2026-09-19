import { access } from 'node:fs/promises';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { ReportPayload, ReportType } from './render.service';
import { REPORT_TEMPLATES } from './render.service';

/**
 * 品牌报告 PDF 渲染(docs/01 §3.8):payload → 矢量 PDF(pdfkit),分节与 HTML 模板一致。
 * - 中文字体复用 assets/fonts/NotoSansSC(insight-pdf 同源,pdfkit 自动子集化)
 * - A4 纵向;表格手绘(列宽/截断/斑马纹);KPI 卡与优先级标签配色对齐控制台
 * - 分节随模板类型裁剪:weekly/diagnostic 无竞品/口碑/引用源,monthly 全量
 */

const FONT_PATH = join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC.ttf');

const NAVY = '#1d3fae';
const BRAND = '#6f7c6d';
const INK = '#3f453e';
const SUB = '#8a877e';
const LINE = '#e4e0d8';
const SOFT = '#f4f6f3';
const WARN = '#c2a26b';

const PAGE = { w: 595.28, h: 841.89, left: 50, right: 50, top: 56, bottom: 56 };
const DOC_BOTTOM = 24;
const CONTENT_W = PAGE.w - PAGE.left - PAGE.right;

export async function renderReportPdf(payload: ReportPayload, type: ReportType): Promise<Buffer> {
  try {
    await access(FONT_PATH);
  } catch {
    throw new Error(`中文字体缺失: ${FONT_PATH}(部署需包含 apps/api/assets/fonts)`);
  }
  const tpl = REPORT_TEMPLATES[type] ?? REPORT_TEMPLATES.weekly;
  const o = payload.overview ?? {};
  const ex = o.excluded ?? {};

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.top, bottom: DOC_BOTTOM, left: PAGE.left, right: PAGE.right },
    info: { Title: `青柠GEO ${tpl.name} · ${payload.brand?.name ?? ''}`, Creator: '青柠GEO' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font(FONT_PATH);
  let y = PAGE.top;
  let lastDrawnPage = 1;

  const drawFooter = (pageNo: number) => {
    doc
      .fillColor(SUB)
      .fontSize(7.5)
      .text(`青柠GEO · ${tpl.name} · ${payload.brand?.name ?? ''} · 第 ${pageNo} 页`, PAGE.left, PAGE.h - 42, {
        width: CONTENT_W,
        align: 'center',
        lineBreak: false,
      });
  };
  doc.on('pageAdded', () => {
    y = PAGE.top;
    lastDrawnPage += 1;
    drawFooter(lastDrawnPage);
  });

  const ensure = (h: number) => {
    if (y + h > PAGE.h - PAGE.bottom) doc.addPage();
  };
  const text = (s: string, size: number, color: string, opts: PDFKit.Mixins.TextOptions = {}) => {
    doc.fillColor(color).fontSize(size).text(s, PAGE.left, y, { width: CONTENT_W, ...opts });
    y = doc.y;
  };
  const truncate = (s: string, maxWidth: number, size: number): string => {
    doc.fontSize(size);
    if (doc.widthOfString(s) <= maxWidth) return s;
    let out = s;
    while (out.length > 1 && doc.widthOfString(`${out}…`) > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
  };
  /** 通用表格:列宽数组 + 行数据(字符串);斑马纹 + 表头底色,行内文本超宽截断。 */
  const table = (headers: string[], widths: number[], rows: string[][]) => {
    const rowH = 20;
    ensure(rowH * 2 + rows.length * rowH + 8);
    doc.rect(PAGE.left, y, CONTENT_W, rowH).fill(SOFT);
    let x = PAGE.left;
    headers.forEach((h, i) => {
      doc.fillColor(SUB).fontSize(8.5).text(h, x + 6, y + 6, { width: widths[i]! - 12, lineBreak: false });
      x += widths[i]!;
    });
    y += rowH;
    rows.forEach((cells, r) => {
      if (y + rowH > PAGE.h - PAGE.bottom) doc.addPage();
      if (r % 2 === 1) doc.rect(PAGE.left, y, CONTENT_W, rowH).fill('#fafaf7');
      let cx = PAGE.left;
      cells.forEach((cell, i) => {
        doc.fillColor(INK).fontSize(8.5).text(truncate(cell, widths[i]! - 12, 8.5), cx + 6, y + 6, {
          width: widths[i]! - 12,
          lineBreak: false,
        });
        cx += widths[i]!;
      });
      y += rowH;
    });
    doc.moveTo(PAGE.left, y).lineTo(PAGE.w - PAGE.right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 14;
  };
  const sectionTitle = (title: string) => {
    ensure(34);
    doc.roundedRect(PAGE.left, y + 1, 3, 11, 1.5).fill(NAVY);
    doc.fillColor(INK).fontSize(12).text(title, PAGE.left + 9, y, { lineBreak: false });
    y += 18;
  };

  // ===== 页眉 =====
  const mcx = PAGE.left + 8;
  const mcy = PAGE.top + 8;
  doc.circle(mcx, mcy, 8).fill(BRAND);
  doc.fillColor(SUB).fontSize(10).text('青柠GEO · AI 搜索品牌可见性监测', PAGE.left + 22, PAGE.top - 1, { lineBreak: false });
  y = PAGE.top + 24;
  text(`${tpl.name} · ${payload.brand?.name ?? ''}`, 20, INK, { lineGap: 2 });
  text(
    `周期 ${payload.period ?? ''} · 生成于 ${payload.generatedAt?.slice(0, 10) ?? ''}${payload.brand?.website ? ' · ' + payload.brand.website : ''}`,
    9,
    SUB,
  );
  y += 8;

  // ===== 体检总览 =====
  sectionTitle('体检总览');
  ensure(64);
  const kpis: Array<[string, string, string]> = [
    ['有效查询', String(o.valid ?? 0), '分母口径内'],
    ['提及率', o.mentionRate == null ? '—' : `${Math.round(o.mentionRate * 100)}%`, `${o.valid ?? 0} 次有效查询的分母`],
    ['Top3 率', o.top3Rate == null ? '—' : `${Math.round(o.top3Rate * 100)}%`, '分母 = 有效且有名次'],
    ['首推率', o.top1Rate == null ? '—' : `${Math.round(o.top1Rate * 100)}%`, `平均名次 ${o.avgRank ?? '—'}`],
  ];
  const cw = (CONTENT_W - 3 * 8) / 4;
  kpis.forEach(([label, value, sub], i) => {
    const x = PAGE.left + i * (cw + 8);
    doc.roundedRect(x, y, cw, 52, 6).fill(SOFT);
    doc.fillColor(SUB).fontSize(8).text(label, x + 10, y + 8, { width: cw - 20, lineBreak: false });
    doc.fillColor(INK).fontSize(15).text(value, x + 10, y + 21, { width: cw - 20, lineBreak: false });
    doc.fillColor(SUB).fontSize(7).text(truncate(sub, cw - 20, 7), x + 10, y + 38, { width: cw - 20, lineBreak: false });
  });
  y += 64;
  if (ex.failed || ex.quotaBlocked) {
    text(`采集失败 ${ex.failed ?? 0} 次、配额拦截 ${ex.quotaBlocked ?? 0} 次,均不计入指标分母。`, 8.5, WARN);
    y += 6;
  }

  // ===== 位次表现(问题分层)=====
  if (payload.questionLayers?.length) {
    sectionTitle('位次表现(问题分层)');
    table(
      ['监控问题', '类型', '分层'],
      [CONTENT_W - 150, 70, 80],
      payload.questionLayers.map((q) => [q.text, q.type === 'ranking' ? '排名词' : '口碑词', q.layer ?? '—']),
    );
  }

  // ===== 竞品格局(monthly)=====
  if (payload.competitors?.length) {
    sectionTitle('竞品格局(同批查询同口径)');
    table(
      ['竞品', '提及次数', '提及率', 'Top3 率'],
      [CONTENT_W - 210, 70, 70, 70],
      payload.competitors.map((c) => [
        c.name,
        String(c.mentions),
        c.mentionRate == null ? '—' : `${Math.round(c.mentionRate * 100)}%`,
        c.top3Rate == null ? '—' : `${Math.round(c.top3Rate * 100)}%`,
      ]),
    );
  }

  // ===== 口碑摘要(monthly)=====
  if (payload.reputation) {
    sectionTitle('口碑摘要');
    ensure(46);
    text(
      `情绪得分 ${payload.reputation.sentimentScore ?? '—'}(口碑词有效回答 ${payload.reputation.runs} 条)`,
      10,
      INK,
    );
    y += 4;
    const weak = payload.reputation.weaknesses ?? [];
    if (weak.length > 0) {
      text(`待攻印象:${weak.map((w) => `${w.term} × ${w.runs}`).join(' · ')}`, 9, SUB);
      y += 4;
    }
  }

  // ===== 引用源概况(monthly)=====
  if (payload.citations) {
    sectionTitle('引用源概况');
    ensure(46);
    const c = payload.citations;
    text(
      `总被引 ${c.total} 条 · 自有域名 ${c.owned} 条 · 占比 ${c.ownedShare == null ? '—' : `${Math.round(c.ownedShare * 100)}%`}`,
      10,
      INK,
    );
    y += 4;
    const top = (c.top ?? []).map((t) => `${t.domain} · ${t.hits}`).join(' · ');
    if (top) {
      text(`高频信源:${top}`, 9, SUB);
      y += 4;
    }
  }

  // ===== 行动清单 =====
  if (payload.actions?.length) {
    sectionTitle('行动清单');
    table(
      ['优先级', '建议动作', '数据依据', '目标'],
      [52, CONTENT_W - 52 - 150 - 60, 150, 60],
      payload.actions.map((a) => [a.priority, a.action, a.dataBasis, a.target]),
    );
  }

  // ===== 附录 =====
  ensure(60);
  doc.moveTo(PAGE.left, y).lineTo(PAGE.w - PAGE.right, y).lineWidth(0.7).strokeColor(LINE).stroke();
  y += 8;
  sectionTitle('附录 · 方法论');
  text(payload.appendix?.methodology ?? '', 9, INK, { lineGap: 2 });
  y += 6;
  text(`行动清单规则集:${payload.appendix?.rulesetVersion ?? ''} · 模板:${tpl.name}`, 8, SUB);

  drawFooter(lastDrawnPage);
  doc.end();
  return done;
}
