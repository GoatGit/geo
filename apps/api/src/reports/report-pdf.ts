import { access } from 'node:fs/promises';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { engineLabel } from '@geo/shared';
import type { ReportPayload, ReportType } from './render.service';
import { REPORT_TEMPLATES } from './render.service';

/**
 * 品牌报告 PDF 渲染(docs/01 §3.8):payload → 矢量 PDF(pdfkit),分节与 HTML 模板一致。
 * - 中文字体复用 assets/fonts/Noto Sans CJK SC Medium(OTF/CFF,macOS 预览渲染锐利)
 * - A4 纵向;表格手绘(列宽/截断/斑马纹);KPI 卡与优先级标签配色对齐控制台
 * - 周报/月报全量分节(体检项/趋势/分引擎/竞品矩阵/口碑天平/信源类别随 payload 出现)
 */

const FONT_PATH = join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansCJKsc-Medium.otf');

const HEALTH_LABELS: Record<string, string> = {
  mentionRate: '提及率',
  top3Rate: 'Top3 率',
  top1Rate: '首推率',
  avgRank: '平均名次',
  sentimentScore: '情绪得分',
  ownedCitationShare: '自有信源占比',
  authoritativeCitationShare: '权威信源引用率',
};

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
    info: { Title: `格尺GEO ${tpl.name} · ${payload.brand?.name ?? ''}`, Creator: '格尺GEO' },
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
      .text(`格尺GEO · ${tpl.name} · ${payload.brand?.name ?? ''} · 第 ${pageNo} 页`, PAGE.left, PAGE.h - 42, {
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
  /** 通用表格:列宽数组 + 行数据(字符串);斑马纹 + 表头底色,行内文本超宽截断。
   *  长表逐行换页(换页重画表头)——一次性 ensure 整表高度会让第 1 页只留标题、
   *  近整页留白(实测周报 26 行问题表)。 */
  const table = (headers: string[], widths: number[], rows: string[][]) => {
    const rowH = 20;
    const drawHeader = () => {
      doc.rect(PAGE.left, y, CONTENT_W, rowH).fill(SOFT);
      let x = PAGE.left;
      headers.forEach((h, i) => {
        doc.fillColor(SUB).fontSize(8.5).text(h, x + 6, y + 6, { width: widths[i]! - 12, lineBreak: false });
        x += widths[i]!;
      });
      y += rowH;
    };
    ensure(rowH * 2); // 标题 + 表头 + 至少一行必须同页
    drawHeader();
    rows.forEach((cells, r) => {
      if (y + rowH > PAGE.h - PAGE.bottom) {
        doc.addPage();
        drawHeader();
      }
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

  // ===== 页眉(品牌标记「六边形格尺」:实心六边形,与产品 logo 同构) =====
  const mcx = PAGE.left + 8;
  const mcy = PAGE.top + 8;
  const mr = 9.5;
  doc.fillColor(BRAND);
  for (let i = 0; i < 6; i++) {
    const rad = ((90 + i * 60) * Math.PI) / 180; // 尖顶朝向,与 logo 一致
    const hx = mcx + mr * Math.cos(rad);
    const hy = mcy - mr * Math.sin(rad);
    if (i === 0) doc.moveTo(hx, hy);
    else doc.lineTo(hx, hy);
  }
  doc.closePath().fill(BRAND);
  doc.fillColor(SUB).fontSize(10).text('格尺GEO · AI 搜索品牌可见性监测', PAGE.left + 22, PAGE.top - 1, { lineBreak: false });
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
    text(`采集失败 ${ex.failed ?? 0} 次、配额拦截 ${ex.quotaBlocked ?? 0} 次,不影响指标计算。`, 8.5, WARN);
    y += 6;
  }

  // ===== 品牌体检(达标线 + 通过态;与控制台总览同源规则)=====
  if (payload.health?.items?.length) {
    sectionTitle('品牌体检');
    table(
      ['指标', '数值', '达标线', '状态'],
      [CONTENT_W - 260, 90, 80, 90],
      payload.health.items.map((i) => {
        const v =
          i.value == null
            ? '—'
            : i.metric === 'avgRank' || i.metric === 'sentimentScore'
              ? String(i.value)
              : `${Math.round(i.value * 100)}%`;
        return [
          HEALTH_LABELS[i.metric] ?? i.metric,
          v,
          i.target ?? '—',
          i.pass === null ? '暂无数据' : i.pass ? '达标' : i.label ?? '待改进',
        ];
      }),
    );
  }

  // ===== 提及率趋势(矢量折线)=====
  const trendPts = (payload.trend ?? []).filter((t) => t.mentionRate != null);
  if (trendPts.length >= 2) {
    sectionTitle('提及率趋势(逐日)');
    ensure(88);
    const tw = CONTENT_W;
    const th = 52;
    const px = (i: number) => PAGE.left + (i / (trendPts.length - 1)) * tw;
    const py = (v: number) => y + th - 6 - v * (th - 12);
    doc.moveTo(PAGE.left, y + th - 5).lineTo(PAGE.w - PAGE.right, y + th - 5).lineWidth(0.6).strokeColor(LINE).stroke();
    for (let i = 1; i < trendPts.length; i++) {
      doc.moveTo(px(i - 1), py(trendPts[i - 1]!.mentionRate!)).lineTo(px(i), py(trendPts[i]!.mentionRate!)).lineWidth(1.6).strokeColor(BRAND).stroke();
    }
    const lastPt = trendPts[trendPts.length - 1]!;
    doc.circle(px(trendPts.length - 1), py(lastPt.mentionRate!), 2).fill(BRAND);
    doc.fillColor(SUB).fontSize(7.5).text(trendPts[0]!.date, PAGE.left, y + th - 2, { lineBreak: false });
    doc
      .fillColor(SUB)
      .fontSize(7.5)
      .text(`${lastPt.date} · ${Math.round((lastPt.mentionRate ?? 0) * 100)}%`, PAGE.w - PAGE.right - 90, y + th - 2, {
        width: 90,
        align: 'right',
        lineBreak: false,
      });
    y += th + 14;
  }

  // ===== 分引擎三率 =====
  if (payload.engineStats?.length) {
    sectionTitle('分引擎三率');
    table(
      ['引擎', '提及率', 'Top3 率', '首推率'],
      [CONTENT_W - 270, 90, 90, 90],
      payload.engineStats.map((e) => [
        engineLabel(e.engine),
        e.mentionRate == null ? '—' : `${Math.round(e.mentionRate * 100)}%`,
        e.top3Rate == null ? '—' : `${Math.round(e.top3Rate * 100)}%`,
        e.top1Rate == null ? '—' : `${Math.round(e.top1Rate * 100)}%`,
      ]),
    );
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

  // ===== 竞品格局(本品 vs 竞品均值 → 榜单 → ×引擎矩阵)=====
  if (payload.competitors?.length) {
    sectionTitle('竞品格局(同批查询同口径)');
    const b = payload.benchmark;
    if (b?.self || b?.competitorAvg) {
      const pctS = (v?: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
      table(
        ['本品 vs 竞品', '提及率', 'Top3 率', '首推率'],
        [CONTENT_W - 270, 90, 90, 90],
        [
          ['本品', pctS(b?.self?.mention), pctS(b?.self?.top3), pctS(b?.self?.top1)],
          ['头部竞品均值', pctS(b?.competitorAvg?.mention), pctS(b?.competitorAvg?.top3), pctS(b?.competitorAvg?.top1)],
        ],
      );
    }
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
    const m = payload.competitorMatrix;
    const mEngines = m?.engines ?? [];
    if (mEngines.length > 0 && m?.rows?.length) {
      text('竞品 × 引擎矩阵(单元格 = 该竞品在该引擎的提及率):', 9, SUB);
      y += 2;
      const cols = [CONTENT_W - 90 * mEngines.length, ...mEngines.map(() => 90)];
      table(
        ['竞品', ...mEngines.map((e) => engineLabel(e))],
        cols,
        m.rows.map((r) => [
          r.name,
          ...mEngines.map((e) => {
            const v = r.engines?.[e];
            return v == null ? '—' : `${Math.round(v * 100)}%`;
          }),
        ]),
      );
    }
  }

  // ===== 口碑天平 =====
  if (payload.reputation) {
    const r = payload.reputation;
    const bd = r.breakdown ?? {};
    sectionTitle('口碑天平');
    ensure(46);
    text(
      `情绪得分 ${r.sentimentScore ?? '—'}(口碑词有效回答 ${r.runs} 条 · 正面 ${bd.pos ?? 0} / 中性 ${bd.neu ?? 0} / 负面 ${bd.neg ?? 0})`,
      10,
      INK,
    );
    y += 4;
    const strong = r.strengths ?? [];
    if (strong.length > 0) {
      text(`优势印象(巩固):${strong.map((w) => `${w.term} × ${w.runs}`).join(' · ')}`, 9, SUB);
      y += 4;
    }
    const weak = r.weaknesses ?? [];
    if (weak.length > 0) {
      text(`待攻印象(攻坚):${weak.map((w) => `${w.term} × ${w.runs}`).join(' · ')}`, 9, SUB);
      y += 4;
    }
  }

  // ===== 信源分析 =====
  if (payload.citations) {
    sectionTitle('信源分析');
    ensure(46);
    const c = payload.citations;
    const pctS = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
    text(
      `总被引 ${c.total} 条 · 权威信源占比 ${pctS(c.authoritativeShare)} · 自有域名占比 ${pctS(c.ownedShare)}`,
      10,
      INK,
    );
    y += 4;
    const cats = (c.categories ?? []).map((t) => `${t.category} · ${t.hits}`).join(' · ');
    if (cats) {
      text(`信源类别:${cats}`, 9, SUB);
      y += 4;
    }
    const top = (c.top ?? []).map((t) => `${t.domain} · ${t.hits}`).join(' · ');
    if (top) {
      text(`高频信源:${top}`, 9, SUB);
      y += 4;
    }
    text('权威信源 = 门户/官媒、权威机构、官网;占比越高,品牌信息的可信背书越足。', 8, SUB);
    y += 4;
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
