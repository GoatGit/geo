import { Injectable } from '@nestjs/common';
import { engineLabel } from '@geo/shared';

/**
 * 报告模板与 HTML 渲染(docs/01 §3.8、docs/03 §3.6):
 * - 模板 = 分节组合,三种类型各自组合;版本随 payload.appendix.rulesetVersion 落库可复现
 * - 渲染产物为自包含 HTML(A4 印刷友好,莫兰迪色);浏览器"打印 → PDF"即得 PDF
 * - 周报/月报均全量分节(品牌洞察汇总:体检/趋势/引擎/分层/竞品矩阵/口碑天平/信源);
 *   快速体检保持轻量三节
 */

export type ReportType = 'weekly' | 'monthly' | 'diagnostic';

export interface ReportTemplateDef {
  type: ReportType;
  name: string;
  desc: string;
  sections: string[];
}

const FULL_SECTIONS = [
  'overview',
  'trend',
  'engines',
  'layers',
  'competitors',
  'reputation',
  'citations',
  'actions',
  'appendix',
];

export const REPORT_TEMPLATES: Record<ReportType, ReportTemplateDef> = {
  weekly: {
    type: 'weekly',
    name: '标准周报',
    desc: '体检总览 + 趋势 + 分引擎三率 + 问题分层 + 竞品矩阵 + 口碑天平 + 信源分析 + 行动清单',
    sections: FULL_SECTIONS,
  },
  monthly: {
    type: 'monthly',
    name: '标准月报',
    desc: '周报全部内容,统计窗口扩展到近 30 天',
    sections: FULL_SECTIONS,
  },
  diagnostic: {
    type: 'diagnostic',
    name: '快速体检',
    desc: '轻量版:体检总览 + 位次表现 + 行动清单',
    sections: ['overview', 'layers', 'actions', 'appendix'],
  },
};

export interface ReportPayload {
  reportType?: string;
  period?: string;
  generatedAt?: string;
  brand?: { name?: string; industry?: string | null; website?: string | null };
  /** 统计窗口天数(周报 7 / 月报 30);旧 payload 缺省按 7 展示 */
  windowDays?: number;
  overview?: {
    valid?: number;
    mentionRate?: number | null;
    top3Rate?: number | null;
    top1Rate?: number | null;
    avgRank?: number | null;
    excluded?: { failed?: number; quotaBlocked?: number };
  };
  health?: {
    summary?: string;
    items?: Array<{ metric: string; value: number | null; target?: string; pass: boolean | null; label?: string }>;
  };
  trend?: Array<{ date: string; mentionRate: number | null }>;
  engineStats?: Array<{ engine: string; mentionRate: number | null; top3Rate: number | null; top1Rate: number | null }>;
  questionLayers?: Array<{ text: string; type: string; layer: string | null }>;
  competitors?: Array<{ name: string; mentions: number; mentionRate: number | null; top3Rate: number | null }>;
  benchmark?: {
    self?: { mention?: number | null; top3?: number | null; top1?: number | null };
    competitorAvg?: { mention?: number | null; top3?: number | null; top1?: number | null };
  };
  competitorMatrix?: {
    engines?: string[];
    rows?: Array<{ name: string; engines: Record<string, number | null> }>;
  };
  reputation?: {
    runs: number;
    sentimentScore: number | null;
    breakdown?: { pos?: number; neu?: number; neg?: number };
    strengths?: Array<{ term: string; runs: number }>;
    weaknesses?: Array<{ term: string; runs: number }>;
  };
  citations?: {
    total: number;
    owned: number;
    ownedShare: number | null;
    authoritative?: number;
    authoritativeShare?: number | null;
    categories?: Array<{ category: string; hits: number }>;
    top: Array<{ domain: string; hits: number }>;
  };
  actions?: Array<{ priority: string; ruleId: string; action: string; dataBasis: string; target: string }>;
  appendix?: { methodology?: string; rulesetVersion?: string };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const HEALTH_LABELS: Record<string, string> = {
  mentionRate: '提及率',
  top3Rate: 'Top3 率',
  top1Rate: '首推率',
  avgRank: '平均名次',
  sentimentScore: '情绪得分',
  ownedCitationShare: '自有信源占比',
  authoritativeCitationShare: '权威信源引用率',
};

/** 每日提及率折线(SVG,印刷友好):窗口 ≥2 个有数据的日期才画。 */
function trendSvg(trend: Array<{ date: string; mentionRate: number | null }>): string | null {
  const pts = trend.filter((t) => t.mentionRate != null);
  if (pts.length < 2) return null;
  const w = 640;
  const h = 64;
  const x = (i: number) => (i / (pts.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - v * (h - 14);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.mentionRate!).toFixed(1)}`).join(' ');
  const area = `${line} ${x(pts.length - 1).toFixed(1)},${h - 4} 4,${h - 4}`;
  const last = pts[pts.length - 1]!;
  return `<svg width="100%" viewBox="0 0 ${w} ${h + 14}" style="display:block;margin-top:6px" preserveAspectRatio="none">
    <line x1="4" y1="${h - 4}" x2="${w - 4}" y2="${h - 4}" stroke="#e4e0d8" stroke-width="1"/>
    <polygon points="${area}" fill="#f4f6f3"/>
    <polyline points="${line}" fill="none" stroke="#6f7c6d" stroke-width="2"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.mentionRate!).toFixed(1)}" r="3" fill="#6f7c6d"/>
    <text x="4" y="${h + 11}" font-size="10" fill="#8a877e">${esc(pts[0]!.date)}</text>
    <text x="${w - 4}" y="${h + 11}" font-size="10" fill="#8a877e" text-anchor="end">${esc(last.date)} · ${Math.round((last.mentionRate ?? 0) * 100)}%</text>
  </svg>`;
}

@Injectable()
export class ReportRenderService {
  templates(): ReportTemplateDef[] {
    return Object.values(REPORT_TEMPLATES);
  }

  /**
   * 模板预览用样例数据(不落库、与任何品牌无关):覆盖全部分节的代表性内容,
   * 让用户在生成前看到真实版式。行业示例与产品定位一致(新能源车)。
   */
  samplePayload(type: ReportType): ReportPayload {
    return {
      reportType: type,
      period: '样例',
      generatedAt: new Date().toISOString(),
      brand: { name: '示例品牌(模板样例)', industry: '汽车', website: 'https://example.com' },
      windowDays: 7,
      overview: {
        valid: 120,
        mentionRate: 0.68,
        top3Rate: 0.45,
        top1Rate: 0.18,
        avgRank: 3.2,
        excluded: { failed: 2, quotaBlocked: 1 },
      },
      health: {
        summary: '4/7 项达标',
        items: [
          { metric: 'mentionRate', value: 0.68, target: '≥ 50%', pass: true, label: '达标' },
          { metric: 'top3Rate', value: 0.45, target: '≥ 45%', pass: true, label: '达标' },
          { metric: 'top1Rate', value: 0.18, target: '≥ 20%', pass: false, label: '需提升' },
          { metric: 'sentimentScore', value: 72, target: '≥ 60', pass: true, label: '达标' },
          { metric: 'ownedCitationShare', value: 0.105, target: '≥ 15%', pass: false, label: '话语权薄弱' },
        ],
      },
      trend: [
        { date: '10-01', mentionRate: 0.6 },
        { date: '10-02', mentionRate: 0.64 },
        { date: '10-03', mentionRate: 0.58 },
        { date: '10-04', mentionRate: 0.7 },
        { date: '10-05', mentionRate: 0.66 },
        { date: '10-06', mentionRate: 0.72 },
        { date: '10-07', mentionRate: 0.68 },
      ],
      engineStats: [
        { engine: 'doubao', mentionRate: 0.85, top3Rate: 0.6, top1Rate: 0.3 },
        { engine: 'deepseek', mentionRate: 0.7, top3Rate: 0.5, top1Rate: 0.2 },
        { engine: 'wenxin', mentionRate: 0.6, top3Rate: 0.4, top1Rate: 0.1 },
        { engine: 'qwen', mentionRate: 0.65, top3Rate: 0.35, top1Rate: 0.15 },
        { engine: 'yuanbao', mentionRate: 0.5, top3Rate: 0.3, top1Rate: 0.1 },
      ],
      questionLayers: [
        { text: '20万左右值得买的纯电轿车有哪些?', type: 'ranking', layer: 'L1' },
        { text: '家里第一辆车买纯电还是混动?', type: 'ranking', layer: 'L2' },
        { text: '哪些新能源车售后服务口碑好?', type: 'reputation', layer: 'L3' },
        { text: '预算25万买SUV,有什么推荐?', type: 'ranking', layer: null },
      ],
      competitors: [
        { name: '竞品A', mentions: 42, mentionRate: 0.82, top3Rate: 0.6 },
        { name: '竞品B', mentions: 31, mentionRate: 0.64, top3Rate: 0.38 },
        { name: '竞品C', mentions: 18, mentionRate: 0.4, top3Rate: 0.15 },
        { name: '竞品D', mentions: 9, mentionRate: 0.22, top3Rate: 0.05 },
      ],
      benchmark: {
        self: { mention: 0.68, top3: 0.45, top1: 0.18 },
        competitorAvg: { mention: 0.52, top3: 0.3, top1: 0.12 },
      },
      competitorMatrix: {
        engines: ['doubao', 'deepseek', 'wenxin', 'qwen', 'yuanbao'],
        rows: [
          { name: '竞品A', engines: { doubao: 0.9, deepseek: 0.8, wenxin: 0.7, qwen: 0.75, yuanbao: 0.6 } },
          { name: '竞品B', engines: { doubao: 0.7, deepseek: 0.65, wenxin: 0.55, qwen: 0.6, yuanbao: 0.45 } },
          { name: '竞品C', engines: { doubao: 0.5, deepseek: 0.4, wenxin: 0.35, qwen: 0.4, yuanbao: 0.3 } },
        ],
      },
      reputation: {
        runs: 18,
        sentimentScore: 72,
        breakdown: { pos: 9, neu: 7, neg: 2 },
        strengths: [
          { term: '续航扎实', runs: 6 },
          { term: '智能化领先', runs: 4 },
        ],
        weaknesses: [
          { term: '售后响应慢', runs: 5 },
          { term: '价格波动', runs: 3 },
        ],
      },
      citations: {
        total: 86,
        owned: 9,
        ownedShare: 0.105,
        authoritative: 31,
        authoritativeShare: 0.36,
        categories: [
          { category: '门户', hits: 22 },
          { category: '垂媒', hits: 18 },
          { category: '资讯', hits: 14 },
        ],
        top: [
          { domain: 'autohome.com.cn', hits: 14 },
          { domain: 'dongchedi.com', hits: 11 },
          { domain: 'zhihu.com', hits: 8 },
        ],
      },
      actions: [
        {
          priority: 'P0',
          ruleId: 'R-L4',
          action: '存在全线缺席问题:补齐该问题的结构化事实内容并核查引用源覆盖',
          dataBasis: '问题分层 L4',
          target: '内容团队',
        },
        {
          priority: 'P1',
          ruleId: 'R-CITE',
          action: '高频信源集中度过高:拓展第三方评测与垂直媒体引用覆盖',
          dataBasis: '引用源 Top3 占比 61%',
          target: '公关/内容',
        },
        {
          priority: 'P2',
          ruleId: 'R-REP',
          action: '跟踪负面印象词条的处置与话术更新',
          dataBasis: '口碑负面印象 Top2',
          target: '客服/公关',
        },
      ],
      appendix: {
        methodology:
          '样例数据仅用于展示模板版式。口径:提及率分母=有效 QueryRun;Top3/首推率分母=有效且有名次;综合名次=未上榜记 N+1 取中位数。',
        rulesetVersion: '2026.09.1',
      },
    };
  }

  render(payload: ReportPayload, type: ReportType): string {
    const tpl = REPORT_TEMPLATES[type] ?? REPORT_TEMPLATES.weekly;
    const sections = tpl.sections
      .map((key) => this.section(key, payload))
      .filter(Boolean)
      .join('\n');

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>格尺GEO ${esc(tpl.name)} · ${esc(payload.brand?.name ?? '')} · ${esc(payload.period ?? '')}</title>
<style>
  :root { --ink:#3f453e; --brand:#6f7c6d; --brand-50:#f4f6f3; --line:#e4e0d8; --bad:#bf8e88; --warn:#c2a26b; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--ink);
         background:#f2f0ea; margin:0; padding:24px; }
  .page { max-width: 794px; margin: 0 auto; background:#fff; padding:48px 56px; border-radius:8px;
          box-shadow:0 2px 12px rgba(60,55,45,.08); }
  h1 { font-size:24px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 14px; color:var(--brand); letter-spacing:.08em; }
  .meta { color:#8a877e; font-size:12px; margin-bottom:28px; }
  section { margin-bottom:34px; page-break-inside: avoid; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:#8a877e; font-weight:500; border-bottom:1px solid var(--line); padding:6px 8px; }
  td { padding:7px 8px; border-bottom:1px solid #f0ede6; }
  .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .kpi { border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .kpi b { display:block; font-size:20px; margin-top:2px; font-variant-numeric:tabular-nums; }
  .kpi span { font-size:11px; color:#8a877e; }
  .tag { display:inline-block; border-radius:4px; padding:1px 6px; font-size:11px; background:var(--brand-50); }
  .p0 { background:#f6ebe9; color:var(--bad); } .p1 { background:#f6f0e2; color:var(--warn); }
  .p2 { background:#efede7; color:#8a877e; }
  .foot { margin-top:36px; padding-top:14px; border-top:1px solid var(--line); font-size:11px; color:#8a877e; line-height:1.8; }
  .brandbar { display:flex; align-items:center; gap:10px; margin-bottom:22px; }
  .brandbar .dot { width:10px; height:10px; border-radius:3px; background:var(--brand); }
  .brandbar b { font-size:15px; }
  @media print { body { background:#fff; padding:0; } .page { box-shadow:none; padding:12mm; border-radius:0; } }
</style></head>
<body><div class="page">
  <div class="brandbar"><svg width="14" height="14" viewBox="0 0 24 24"><path fill="#6f7c6d" fill-rule="evenodd" d="M12 2 20.66 7 20.66 17 12 22 3.34 17 3.34 7ZM12 5.8 17.37 8.9 17.37 15.1 12 18.2 6.63 15.1 6.63 8.9ZM12.2 7.4h1.5v4.2h-1.5ZM14.6 8.8h1.5v2.8h-1.5Z"/></svg><b>格尺GEO</b><span style="color:#8a877e;font-size:12px">AI 搜索品牌可见性监测</span></div>
  <h1>${esc(tpl.name)} · ${esc(payload.brand?.name ?? '')}</h1>
  <p class="meta">周期 ${esc(payload.period ?? '')} · 生成于 ${esc(payload.generatedAt ?? '')}${payload.brand?.website ? ' · ' + esc(payload.brand.website) : ''}</p>
  ${sections}
  <div class="foot">
    口径与方法论:${esc(payload.appendix?.methodology ?? '')}<br/>
    行动清单规则集:${esc(payload.appendix?.rulesetVersion ?? '')} · 模板:${esc(tpl.name)} · 原始快照按保留策略过期,报告内证据已随报告归档。
  </div>
</div></body></html>`;
  }

  private section(key: string, p: ReportPayload): string | null {
    const o = p.overview ?? {};
    if (key === 'overview') {
      const ex = o.excluded ?? {};
      // 体检项(与控制台总览同源):达标线 + 通过态
      const healthItems = (p.health?.items ?? [])
        .map((i) => {
          const label = HEALTH_LABELS[i.metric] ?? i.metric;
          const value = i.value == null ? '—' : i.metric === 'avgRank' || i.metric === 'sentimentScore' ? String(i.value) : pct(i.value);
          const tone = i.pass === null ? 'background:#efede7;color:#8a877e' : i.pass ? 'background:#eef2ec;color:#5a7355' : 'background:#f6f0e2;color:#a3854e';
          return `<span class="tag" style="${tone};margin:0 6px 6px 0">${label} ${value} · ${i.pass === null ? '暂无数据' : i.pass ? '达标' : esc(i.label ?? '待改进')}${i.target ? `(${esc(i.target)})` : ''}</span>`;
        })
        .join('');
      return `<section><h2>体检总览</h2><div class="cards">
        <div class="kpi"><span>有效查询</span><b>${o.valid ?? 0}</b><span>近 ${p.windowDays ?? 7} 天</span></div>
        <div class="kpi"><span>提及率</span><b>${pct(o.mentionRate)}</b><span>${o.valid ?? 0} 次有效查询的分母</span></div>
        <div class="kpi"><span>Top3 率</span><b>${pct(o.top3Rate)}</b><span>分母 = 有效且有名次</span></div>
        <div class="kpi"><span>首推率</span><b>${pct(o.top1Rate)}</b><span>平均名次 ${o.avgRank ?? '—'}</span></div>
      </div>
      ${healthItems ? `<p style="font-size:11px;margin:10px 0 0;line-height:2">${healthItems}</p>` : ''}
      ${ex.failed || ex.quotaBlocked ? `<p style="font-size:11px;color:var(--warn);margin-top:8px">采集失败 ${ex.failed ?? 0} 次、配额拦截 ${ex.quotaBlocked ?? 0} 次,不影响指标计算。</p>` : ''}
      </section>`;
    }
    if (key === 'trend' && p.trend?.length) {
      const svg = trendSvg(p.trend);
      if (!svg) return null;
      return `<section><h2>提及率趋势(逐日)</h2>${svg}
        <p style="font-size:11px;color:#8a877e;margin:4px 0 0">每日提及率 = 当日提及本品的回答数 ÷ 当日有效回答数;空白日无有效采集。</p></section>`;
    }
    if (key === 'engines' && p.engineStats?.length) {
      const rows = p.engineStats
        .map((e) => {
          const bar = (v: number | null) =>
            v == null
              ? '<span style="color:#8a877e">—</span>'
              : `<span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:70px;height:5px;background:#f0ede6;border-radius:3px"><span style="display:inline-block;height:5px;background:var(--brand);border-radius:3px;width:${Math.round(v * 100)}%"></span></span>${pct(v)}</span>`;
          return `<tr><td>${esc(engineLabel(e.engine))}</td><td>${bar(e.mentionRate)}</td><td>${bar(e.top3Rate)}</td><td>${bar(e.top1Rate)}</td></tr>`;
        })
        .join('');
      return `<section><h2>分引擎三率</h2><table>
        <thead><tr><th>引擎</th><th>提及率</th><th>Top3 率</th><th>首推率</th></tr></thead><tbody>${rows}</tbody></table>
        <p style="font-size:11px;color:#8a877e;margin:6px 0 0">与控制台「排名透视 → 分引擎三率」同口径;某引擎本期零成功采集时不会出现在此表。</p></section>`;
    }
    if (key === 'layers' && p.questionLayers?.length) {
      const counts = ['L1', 'L2', 'L3', 'L4'].map((l) => `${l} × ${p.questionLayers!.filter((q) => q.layer === l).length}`).join(' · ');
      const rows = p.questionLayers
        .map(
          (q) => `<tr><td>${esc(q.text)}</td><td>${q.type === 'ranking' ? '排名词' : '口碑词'}</td>
          <td>${q.layer ? `<span class="tag">${esc(q.layer)}</span>` : '—'}</td></tr>`,
        )
        .join('');
      return `<section><h2>位次表现(问题分层)</h2>
        ${counts ? `<p style="font-size:12px;margin:0 0 8px;color:#8a877e">分层分布:${counts}(L1=多引擎进 Top3 … L4=全线缺席)</p>` : ''}
        <table>
        <thead><tr><th>监控问题</th><th>类型</th><th>分层</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }
    if (key === 'competitors' && p.competitors?.length) {
      const rows = p.competitors
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td>${c.mentions}</td><td>${pct(c.mentionRate)}</td><td>${pct(c.top3Rate)}</td></tr>`,
        )
        .join('');
      // 本品 vs 头部竞品均值(竞品透视同款对比)
      const b = p.benchmark;
      const cmpRow = (label: string, r?: { mention?: number | null; top3?: number | null; top1?: number | null }) =>
        `<tr><td>${label}</td><td>${pct(r?.mention)}</td><td>${pct(r?.top3)}</td><td>${pct(r?.top1)}</td></tr>`;
      const bench = b?.self || b?.competitorAvg
        ? `<table style="margin-bottom:12px">
            <thead><tr><th>本品 vs 竞品</th><th>提及率</th><th>Top3 率</th><th>首推率</th></tr></thead>
            <tbody>${cmpRow('本品', b?.self)}${cmpRow('头部竞品均值', b?.competitorAvg)}</tbody></table>`
        : '';
      // 竞品×引擎矩阵(热力:提及率越高背景越深)
      const m = p.competitorMatrix;
      const matrix =
        m?.engines?.length && m.rows?.length
          ? `<table><thead><tr><th>竞品 × 引擎</th>${m.engines.map((e) => `<th>${esc(engineLabel(e))}</th>`).join('')}</tr></thead>
             <tbody>${m.rows
               .map(
                 (r) =>
                   `<tr><td>${esc(r.name)}</td>${m.engines!
                     .map((e) => {
                       const v = r.engines?.[e];
                       const bg = v == null ? '' : `background:rgba(111,124,109,${(0.08 + v * 0.6).toFixed(2)});color:${v > 0.55 ? '#fff' : 'inherit'}`;
                       return `<td style="${bg}border-radius:4px">${v == null ? '—' : `${Math.round(v * 100)}%`}</td>`;
                     })
                     .join('')}</tr>`,
               )
               .join('')}</tbody></table>
             <p style="font-size:11px;color:#8a877e;margin:6px 0 0">单元格 = 该竞品在该引擎的提及率,颜色越深越高(与竞品透视热力矩阵同源)。</p>`
          : '';
      return `<section><h2>竞品格局(同批查询同口径)</h2>${bench}
        <table>
        <thead><tr><th>竞品</th><th>提及次数</th><th>提及率</th><th>Top3 率</th></tr></thead><tbody>${rows}</tbody></table>
        ${matrix ? `<div style="margin-top:12px">${matrix}</div>` : ''}</section>`;
    }
    if (key === 'reputation' && p.reputation) {
      const r = p.reputation;
      const bd = r.breakdown ?? {};
      const strengths = (r.strengths ?? [])
        .map((w) => `<span class="tag" style="margin-right:6px;background:#eef2ec;color:#5a7355">${esc(w.term)} × ${w.runs}</span>`)
        .join('');
      const weak = (r.weaknesses ?? [])
        .map((w) => `<span class="tag" style="margin-right:6px;background:#f6ebe9;color:var(--bad)">${esc(w.term)} × ${w.runs}</span>`)
        .join('');
      return `<section><h2>口碑天平</h2>
        <p style="font-size:13px;margin:0 0 6px">情绪得分 <b style="font-size:18px">${r.sentimentScore ?? '—'}</b>
        <span style="color:#8a877e;font-size:12px">(口碑词有效回答 ${r.runs} 条 · 正面 ${bd.pos ?? 0} / 中性 ${bd.neu ?? 0} / 负面 ${bd.neg ?? 0})</span></p>
        ${strengths ? `<p style="font-size:12px;margin:6px 0 0">优势印象(巩固):${strengths}</p>` : ''}
        ${weak ? `<p style="font-size:12px;margin:6px 0 0">待攻印象(攻坚):${weak}</p>` : ''}</section>`;
    }
    if (key === 'citations' && p.citations) {
      const c = p.citations;
      const top = (c.top ?? [])
        .map((t) => `<span class="tag" style="margin-right:6px">${esc(t.domain)} · ${t.hits}</span>`)
        .join('');
      const cats = (c.categories ?? [])
        .map((t) => `<span class="tag" style="margin-right:6px">${esc(t.category)} · ${t.hits}</span>`)
        .join('');
      return `<section><h2>信源分析</h2>
        <p style="font-size:13px;margin:0 0 6px">总被引 <b>${c.total}</b> 条 · 权威信源占比 <b>${pct(c.authoritativeShare)}</b> · 自有域名占比 <b>${pct(c.ownedShare)}</b></p>
        ${cats ? `<p style="font-size:12px;margin:6px 0 0">信源类别:${cats}</p>` : ''}
        ${top ? `<p style="font-size:12px;margin:6px 0 0">高频信源:${top}</p>` : ''}
        <p style="font-size:11px;color:#8a877e;margin:6px 0 0">权威信源 = 门户/官媒、权威机构、官网;占比越高,品牌信息的可信背书越足。</p></section>`;
    }
    if (key === 'actions' && p.actions?.length) {
      const rows = p.actions
        .map(
          (a) =>
            `<tr><td><span class="tag ${a.priority.toLowerCase()}">${a.priority}</span></td>
             <td>${esc(a.action)}</td><td style="color:#8a877e">${esc(a.dataBasis)}</td><td>${esc(a.target)}</td></tr>`,
        )
        .join('');
      return `<section><h2>行动清单</h2><table>
        <thead><tr><th>优先级</th><th>建议动作</th><th>数据依据</th><th>目标</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }
    if (key === 'appendix') {
      return `<section><h2>附录 · 方法论</h2>
        <p style="font-size:12px;line-height:1.9;margin:0">${esc(p.appendix?.methodology ?? '')}</p></section>`;
    }
    return null;
  }
}
