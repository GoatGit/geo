import { access } from 'node:fs/promises';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type {
  BarRankBlock,
  FunnelBlock,
  HeatmapBlock,
  InsightBlock,
  InsightCover,
  RadarBlock,
  ScatterBlock,
  TakeawayBlock,
  TrendBlock,
} from '@geo/shared';

/** PDF 渲染输入:与服务层返回结构对齐(时间字段 Date/string 均可,只取展示字段)。 */
export interface PdfInsight {
  id: number;
  industry: string;
  issue: string;
  title: string;
  summary: string;
  cover: InsightCover;
  blocks: InsightBlock[];
  windowDays?: number | null;
  buildStatus?: string;
}

/**
 * 行业洞察 PDF 渲染(docs/01 §3.10):blocks → 矢量 PDF(pdfkit)。
 * - 中文字体打包在 assets/fonts(Noto Sans SC,OFL 许可);pdfkit 自动子集化,产物仅数十 KB
 * - 配色与控制台图表一致(insight-charts.tsx):NAVY/BRAND/ORANGE/GRAY
 * - A4 纵向,内容游标不足即换页;每页页脚带页码
 */

const FONT_PATH = join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC.ttf');

const NAVY = '#1d3fae';
const BRAND = '#6f7c6d';
const ORANGE = '#c2570b';
const GRAY = '#9aa3af';
const INK = '#3f453e';
const SUB = '#8a877e';
const LINE = '#e4e0d8';
const SOFT = '#f4f6f3';

const SERIES_COLORS = [NAVY, ORANGE, BRAND, '#8a7ba8', '#3d8f8a', '#b0885e'];

const PAGE = { w: 595.28, h: 841.89, left: 50, right: 50, top: 56, bottom: 64 };
// pdfkit 的实际 bottom margin 只留 24pt:页脚固定画在 h-42 处,
// 若页脚落在 margin 之外的布局区,doc.text 会触发自动换页 → pageAdded → 再画页脚 → 无限递归。
const DOC_BOTTOM = 24;
const CONTENT_W = PAGE.w - PAGE.left - PAGE.right;

/** 颜色向白色混合(pdfkit 不直接支持半透明填充的稳定写法,预混出实色)。 */
function blend(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * (1 - alpha));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export async function renderInsightPdf(detail: PdfInsight): Promise<Buffer> {
  try {
    await access(FONT_PATH);
  } catch {
    throw new Error(`中文字体缺失: ${FONT_PATH}(部署需包含 apps/api/assets/fonts)`);
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.top, bottom: DOC_BOTTOM, left: PAGE.left, right: PAGE.right },
    info: { Title: detail.title, Creator: '青柠GEO' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font(FONT_PATH);
  let y = PAGE.top;
  let lastDrawnPage = 1;

  const drawFooter = (pageNo: number) => {
    doc
      .fillColor(GRAY)
      .fontSize(7.5)
      .text(`青柠GEO · 行业洞察 · ${detail.industry || ''} · 第 ${pageNo} 页`, PAGE.left, PAGE.h - 42, {
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

  /** 剩余空间不足 h 则换页(pageAdded 会重置 y)。 */
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

  // ===== 各块渲染器 =====

  const takeaway = (b: TakeawayBlock) => {
    const tone = b.tone === 'warn' ? ORANGE : b.tone === 'good' ? BRAND : NAVY;
    doc.fontSize(10);
    const lines = Math.max(1, Math.ceil(doc.widthOfString(b.text) / (CONTENT_W - 44)));
    const boxH = 32 + lines * 14;
    ensure(boxH + 8);
    doc.roundedRect(PAGE.left, y, CONTENT_W, boxH, 6).fill(SOFT);
    doc.roundedRect(PAGE.left, y, 3, boxH, 1.5).fill(tone);
    doc.fillColor(tone).fontSize(9.5).text(b.title, PAGE.left + 14, y + 9, { width: CONTENT_W - 28, lineBreak: false });
    doc.fillColor(INK).fontSize(10).text(b.text, PAGE.left + 14, y + 25, { width: CONTENT_W - 28, lineGap: 3 });
    y += boxH + 8;
  };

  const barRank = (b: BarRankBlock) => {
    const labelW = 128;
    const valueW = 64;
    const trackW = CONTENT_W - labelW - valueW - 16;
    const isPct = b.unit === '%';
    const maxV = isPct ? 100 : Math.max(...b.items.map((i) => i.value), 1);
    const rowH = 17;
    ensure(b.items.length * rowH + 6);
    b.items.forEach((item, i) => {
      const ry = y + i * rowH;
      const color = item.group === 'highlight' ? ORANGE : item.group === 'intl' ? GRAY : NAVY;
      doc.fillColor(INK).fontSize(8.5).text(truncate(item.name, labelW, 8.5), PAGE.left, ry + 3, { width: labelW, lineBreak: false });
      doc.roundedRect(PAGE.left + labelW + 6, ry + 3, trackW, 9, 3).fill('#eef0f4');
      const w = Math.max((item.value / maxV) * trackW, 2);
      doc.roundedRect(PAGE.left + labelW + 6, ry + 3, w, 9, 3).fill(color);
      const label = isPct ? `${item.value}%` : `${item.value} / ${b.total}`;
      doc.fillColor(SUB).fontSize(8).text(label, PAGE.left + labelW + trackW + 12, ry + 3.5, {
        width: valueW,
        align: 'right',
        lineBreak: false,
      });
    });
    y += b.items.length * rowH + 4;
  };

  const funnel = (b: FunnelBlock) => {
    const first = b.stages[0]?.count || 1;
    const rowH = 26;
    ensure(b.stages.length * rowH + 6);
    const shades = [NAVY, blend(NAVY, 0.72), blend(NAVY, 0.45), blend(NAVY, 0.2)];
    b.stages.forEach((s, i) => {
      const sy = y + i * rowH;
      const w = Math.max((s.count / first) * CONTENT_W, 64);
      const x = PAGE.left + (CONTENT_W - w) / 2;
      doc.roundedRect(x, sy, w, 19, 4).fill(shades[Math.min(i, 3)]);
      doc
        .fillColor(i < 2 ? '#ffffff' : INK)
        .fontSize(8.5)
        .text(`${s.label} ${s.count}`, x, sy + 5.5, { width: w, align: 'center', lineBreak: false });
      if (i > 0) {
        const prev = b.stages[i - 1].count;
        doc
          .fillColor(SUB)
          .fontSize(7.5)
          .text(prev > 0 ? `${Math.round((s.count / prev) * 100)}%` : '—', PAGE.w - PAGE.right - 46, sy + 6, {
            width: 46,
            align: 'right',
            lineBreak: false,
          });
      }
    });
    y += b.stages.length * rowH + 4;
  };

  const heatmap = (b: HeatmapBlock) => {
    const labelW = 118;
    const cols = Math.max(b.columns.length, 1);
    const cellW = Math.min((CONTENT_W - labelW - 8) / cols, 92);
    const cellH = 22;
    ensure(b.rows.length * cellH + cellH + 6);
    b.columns.forEach((c, j) => {
      doc
        .fillColor(SUB)
        .fontSize(8)
        .text(truncate(c, cellW - 4, 8), PAGE.left + labelW + 8 + j * cellW, y, {
          width: cellW - 6,
          align: 'center',
          lineBreak: false,
        });
    });
    y += cellH - 4;
    b.rows.forEach((row, i) => {
      const ry = y + i * cellH;
      doc.fillColor(INK).fontSize(8.5).text(truncate(row.name, labelW, 8.5), PAGE.left, ry + 5, { width: labelW, lineBreak: false });
      row.cells.forEach((v, j) => {
        const cx = PAGE.left + labelW + 8 + j * cellW;
        if (v == null) {
          doc.roundedRect(cx, ry + 1, cellW - 5, cellH - 4, 3).fill('#f3f2ee');
        } else {
          doc.roundedRect(cx, ry + 1, cellW - 5, cellH - 4, 3).fill(blend(NAVY, 0.12 + v * 0.78));
          doc
            .fillColor(v > 0.55 ? '#ffffff' : INK)
            .fontSize(8)
            .text(`${Math.round(v * 100)}%`, cx, ry + 6, { width: cellW - 5, align: 'center', lineBreak: false });
        }
      });
    });
    y += b.rows.length * cellH + 4;
  };

  const radar = (b: RadarBlock) => {
    const size = 205;
    ensure(size + 40);
    // 圆心等坐标必须在 ensure 之后计算:换页会重置 y 游标
    const cx = PAGE.left + CONTENT_W / 2;
    const cy = y + size / 2 + 6;
    const R = size / 2 - 26;
    const n = b.axes.length;
    const angle = (k: number) => -Math.PI / 2 + (k * 2 * Math.PI) / n;
    for (let ring = 1; ring <= 3; ring++) {
      const rr = (R * ring) / 3;
      doc.moveTo(cx + rr * Math.cos(angle(0)), cy + rr * Math.sin(angle(0)));
      for (let k = 1; k < n; k++) doc.lineTo(cx + rr * Math.cos(angle(k)), cy + rr * Math.sin(angle(k)));
      doc.closePath().lineWidth(0.6).strokeColor(LINE).stroke();
    }
    doc.fontSize(7.5);
    b.axes.forEach((axis, k) => {
      const ex = angle(k);
      doc.moveTo(cx, cy).lineTo(cx + R * Math.cos(ex), cy + R * Math.sin(ex)).lineWidth(0.6).strokeColor(LINE).stroke();
      doc
        .fillColor(SUB)
        .text(axis, cx + (R + 6) * Math.cos(ex) - 22, cy + (R + 6) * Math.sin(ex) - 4, {
          width: 44,
          align: 'center',
          lineBreak: false,
        });
    });
    b.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      doc.moveTo(cx + R * (s.values[0] ?? 0) * Math.cos(angle(0)), cy + R * (s.values[0] ?? 0) * Math.sin(angle(0)));
      for (let k = 1; k < n; k++) {
        const v = s.values[k] ?? 0;
        doc.lineTo(cx + R * v * Math.cos(angle(k)), cy + R * v * Math.sin(angle(k)));
      }
      doc.closePath().fillColor(blend(color, 0.16)).fill().lineWidth(1.1).strokeColor(color).stroke();
    });
    y = cy + R + 16;
    doc.fontSize(8);
    let lx = PAGE.left;
    b.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      const label = truncate(s.name, 96, 8);
      doc.roundedRect(lx, y - 1, 7, 7, 2).fill(color);
      doc.fillColor(INK).text(label, lx + 11, y - 2, { lineBreak: false });
      lx += 11 + doc.widthOfString(label) + 14;
    });
    y += 14;
  };

  const trend = (b: TrendBlock) => {
    const h = 130;
    ensure(h + 36);
    const plotW = CONTENT_W - 40;
    const plotX = PAGE.left + 8;
    const plotTop = y + 12;
    const pts = b.points;
    const isPct = b.unit === '%';
    const maxV = isPct ? 100 : Math.max(...pts.map((p) => p.value ?? 0), 1);
    const px = (i: number) => plotX + (pts.length <= 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
    const py = (v: number) => plotTop + h - (v / maxV) * (h - 14);
    doc.moveTo(plotX, plotTop).lineTo(plotX, plotTop + h).lineTo(plotX + plotW, plotTop + h).lineWidth(0.7).strokeColor(LINE).stroke();

    const segments: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    pts.forEach((p, i) => {
      if (p.value == null) {
        if (cur.length > 0) segments.push(cur);
        cur = [];
        return;
      }
      cur.push([px(i), py(p.value)]);
    });
    if (cur.length > 0) segments.push(cur);

    for (const seg of segments) {
      if (seg.length > 2) {
        doc.moveTo(seg[0][0], plotTop + h);
        for (const [sx, sy] of seg) doc.lineTo(sx, sy);
        doc.lineTo(seg[seg.length - 1][0], plotTop + h);
        doc.closePath().fillColor(blend(NAVY, 0.08)).fill();
      }
      doc.moveTo(seg[0][0], seg[0][1]);
      for (const [sx, sy] of seg.slice(1)) doc.lineTo(sx, sy);
      doc.strokeColor(NAVY).lineWidth(1.4).stroke();
      for (const [sx, sy] of seg) doc.circle(sx, sy, 1.8).fillColor(NAVY).fill();
    }

    doc.fontSize(7);
    const step = Math.max(1, Math.ceil(pts.length / 8));
    pts.forEach((p, i) => {
      if (i % step === 0 || i === pts.length - 1) {
        doc.fillColor(SUB).text(p.label, px(i) - 18, plotTop + h + 6, { width: 36, align: 'center', lineBreak: false });
      }
    });
    doc.fillColor(SUB).text('0', PAGE.left - 2, plotTop + h - 4, { width: 20, align: 'right', lineBreak: false });
    doc.fillColor(SUB).text(isPct ? '100%' : String(maxV), PAGE.left - 2, plotTop - 2, { width: 20, align: 'right', lineBreak: false });
    y = plotTop + h + 20;
  };

  const scatter = (b: ScatterBlock) => {
    const size = 235;
    ensure(size + 44);
    // 绘图区坐标在 ensure 之后取 y:换页重置游标后才能落在页首
    const plotX = PAGE.left + 26;
    const plotY = y + 8;
    const plotW = CONTENT_W - 60;
    const sx = (v: number) => plotX + v * plotW;
    const sy = (v: number) => plotY + size - v * size;
    doc.rect(plotX, plotY, plotW, size).lineWidth(0.7).strokeColor(LINE).stroke();
    if (b.diagonal) {
      doc.moveTo(sx(0), sy(0)).lineTo(sx(1), sy(1)).lineWidth(0.6).strokeColor(GRAY).dash(3, 3).stroke().undash();
    }
    const maxSize = Math.max(...b.points.map((p) => p.size ?? 1), 1);
    doc.fontSize(8);
    b.points.forEach((p, i) => {
      const color = p.group === 'highlight' ? ORANGE : SERIES_COLORS[i % SERIES_COLORS.length];
      const r = 4 + ((p.size ?? 1) / maxSize) * 7;
      doc.circle(sx(p.x), sy(p.y), r).fillColor(blend(color, 0.55)).fill();
      doc.fillColor(INK).text(truncate(p.name, 70, 8), sx(p.x) + r + 3, sy(p.y) - 4, { lineBreak: false });
    });
    doc.fillColor(SUB).fontSize(7.5).text(b.xLabel, plotX, plotY + size + 6, { width: plotW, align: 'center' });
    doc.fillColor(SUB).fontSize(7.5).text(b.yLabel, plotX - 10, plotY - 12, { lineBreak: false });
    y = plotY + size + 20;
  };

  const renderers: { [K in InsightBlock['type']]: (b: Extract<InsightBlock, { type: K }>) => void } = {
    takeaway,
    barRank,
    funnel,
    heatmap,
    radar,
    trend,
    scatter,
  };

  /** 各块渲染高度的粗估:用于换页判断,标题必须与内容同页。 */
  function estimateBlockHeight(b: InsightBlock): number {
    switch (b.type) {
      case 'takeaway':
        return 110;
      case 'barRank':
        return b.items.length * 17 + 80;
      case 'funnel':
        return b.stages.length * 26 + 80;
      case 'heatmap':
        return (b.rows.length + 1) * 22 + 80;
      case 'radar':
        return 300;
      case 'trend':
        return 240;
      case 'scatter':
        return 330;
    }
  }

  // ===== 页眉(品牌标记「光圈青柠」:圆盘 + 三道楔形切口) =====
  const mcx = PAGE.left + 8;
  const mcy = PAGE.top + 8;
  const mr = 8;
  doc.circle(mcx, mcy, mr).fill(BRAND);
  doc.fillColor('#ffffff');
  for (const baseDeg of [-90, 30, 150]) {
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const r1 = mr * 0.3;
    const r2 = mr * 0.99;
    const pts: Array<[number, number]> = [
      [mcx + r1 * Math.cos(rad(baseDeg - 13)), mcy + r1 * Math.sin(rad(baseDeg - 13))],
      [mcx + r2 * Math.cos(rad(baseDeg - 13)), mcy + r2 * Math.sin(rad(baseDeg - 13))],
      [mcx + r2 * Math.cos(rad(baseDeg + 13)), mcy + r2 * Math.sin(rad(baseDeg + 13))],
      [mcx + r1 * Math.cos(rad(baseDeg + 13)), mcy + r1 * Math.sin(rad(baseDeg + 13))],
    ];
    doc.moveTo(pts[0]![0], pts[0]![1]).lineTo(pts[1]![0], pts[1]![1]).lineTo(pts[2]![0], pts[2]![1]).lineTo(pts[3]![0], pts[3]![1]).closePath().fill('#ffffff');
  }
  doc.fillColor(BRAND).fontSize(10).text('青柠GEO · AI 搜索品牌可见性监测', PAGE.left + 22, PAGE.top - 1, { lineBreak: false });
  y = PAGE.top + 24;
  text(detail.title, 20, INK, { lineGap: 2 });
  const windowText = detail.windowDays ? `近 ${detail.windowDays} 天` : '全量历史';
  const meta = [
    detail.industry ? `行业:${detail.industry}` : '',
    detail.issue,
    `数据窗口:${windowText}`,
    detail.cover?.testedAt ? `数据截至 ${detail.cover.testedAt}` : '',
    `生成于 ${new Date().toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  text(meta, 9, SUB);
  y += 6;

  // ===== 封面 KPI =====
  const kpis: Array<[string, string]> = [];
  if (detail.cover?.headline) kpis.push(['头部品牌', detail.cover.headline]);
  if (detail.cover?.brands != null) kpis.push(['监测品牌', String(detail.cover.brands)]);
  if (detail.cover?.questions != null) kpis.push(['监控问题', String(detail.cover.questions)]);
  if (detail.cover?.answers != null) kpis.push(['有效回答', String(detail.cover.answers)]);
  if (kpis.length > 0) {
    const cw = (CONTENT_W - (kpis.length - 1) * 8) / kpis.length;
    ensure(58);
    kpis.forEach(([label, value], i) => {
      const x = PAGE.left + i * (cw + 8);
      doc.roundedRect(x, y, cw, 46, 6).fill(SOFT);
      doc.fillColor(SUB).fontSize(8).text(label, x + 10, y + 8, { width: cw - 20, lineBreak: false });
      doc.fillColor(INK).fontSize(12).text(value, x + 10, y + 22, { width: cw - 20, ellipsis: true, height: 18, lineBreak: false });
    });
    y += 58;
  }

  if (detail.summary) {
    text(detail.summary, 10, INK, { lineGap: 3 });
    y += 6;
  }

  // ===== 内容块 =====
  for (const block of detail.blocks ?? []) {
    const note = 'note' in block ? block.note : undefined;
    // 先保证标题+整块内容同页,再落标题(避免标题孤儿)
    ensure(estimateBlockHeight(block) + (note ? 20 : 8));
    doc.roundedRect(PAGE.left, y + 1, 3, 11, 1.5).fill(NAVY);
    doc.fillColor(INK).fontSize(12).text(block.title, PAGE.left + 9, y, { lineBreak: false });
    y += 18;
    if (note) {
      text(note, 8, SUB, { lineGap: 1 });
      y += 4;
    }
    renderers[block.type](block as never);
    y += 18;
  }

  // ===== 附录 =====
  ensure(72);
  doc.moveTo(PAGE.left, y).lineTo(PAGE.w - PAGE.right, y).lineWidth(0.7).strokeColor(LINE).stroke();
  y += 8;
  text(
    '口径说明:提及率分母 = 有效回答(ok_with_answer + ok_empty);Top3/首位率分母 = 有效且有名次;采集失败与配额拦截不计入分母。' +
      '数据来源于 GeoLens 中立账号对主流 AI 引擎的持续监测,原始回答与快照存证可回溯。',
    8,
    SUB,
    { lineGap: 2 },
  );

  drawFooter(lastDrawnPage);

  doc.end();
  return done;
}
