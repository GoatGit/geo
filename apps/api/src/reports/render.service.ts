import { Injectable } from '@nestjs/common';

/**
 * 报告模板与 HTML 渲染(docs/01 §3.8、docs/03 §3.6):
 * - 模板 = 分节组合,三种类型各自组合;版本随 payload.appendix.rulesetVersion 落库可复现
 * - 渲染产物为自包含 HTML(A4 印刷友好,莫兰迪色);浏览器"打印 → PDF"即得 PDF
 */

export type ReportType = 'weekly' | 'monthly' | 'diagnostic';

export interface ReportTemplateDef {
  type: ReportType;
  name: string;
  desc: string;
  sections: string[];
}

export const REPORT_TEMPLATES: Record<ReportType, ReportTemplateDef> = {
  weekly: {
    type: 'weekly',
    name: '标准周报',
    desc: '体检总览 · 位次表现 · 行动清单 · 方法论附录',
    sections: ['overview', 'layers', 'actions', 'appendix'],
  },
  monthly: {
    type: 'monthly',
    name: '标准月报',
    desc: '周报全部内容 + 竞品格局 + 口碑摘要 + 引用源概况',
    sections: ['overview', 'layers', 'competitors', 'reputation', 'citations', 'actions', 'appendix'],
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
  overview?: {
    valid?: number;
    mentionRate?: number | null;
    top3Rate?: number | null;
    top1Rate?: number | null;
    avgRank?: number | null;
    excluded?: { failed?: number; quotaBlocked?: number };
  };
  questionLayers?: Array<{ text: string; type: string; layer: string | null }>;
  competitors?: Array<{ name: string; mentions: number; mentionRate: number | null; top3Rate: number | null }>;
  reputation?: { runs: number; sentimentScore: number | null; weaknesses?: Array<{ term: string; runs: number }> };
  citations?: { total: number; owned: number; ownedShare: number | null; top: Array<{ domain: string; hits: number }> };
  actions?: Array<{ priority: string; ruleId: string; action: string; dataBasis: string; target: string }>;
  appendix?: { methodology?: string; rulesetVersion?: string };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

@Injectable()
export class ReportRenderService {
  templates(): ReportTemplateDef[] {
    return Object.values(REPORT_TEMPLATES);
  }

  render(payload: ReportPayload, type: ReportType): string {
    const tpl = REPORT_TEMPLATES[type] ?? REPORT_TEMPLATES.weekly;
    const sections = tpl.sections
      .map((key) => this.section(key, payload))
      .filter(Boolean)
      .join('\n');

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>GeoLens ${esc(tpl.name)} · ${esc(payload.brand?.name ?? '')} · ${esc(payload.period ?? '')}</title>
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
  <div class="brandbar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6f7c6d" stroke-width="2.4" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="12" r="3.5"/></svg><b>GeoLens</b><span style="color:#8a877e;font-size:12px">AI 搜索品牌可见性监测</span></div>
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
      return `<section><h2>体检总览</h2><div class="cards">
        <div class="kpi"><span>有效查询</span><b>${o.valid ?? 0}</b></div>
        <div class="kpi"><span>提及率</span><b>${pct(o.mentionRate)}</b><span>${o.valid ?? 0} 次有效查询的分母</span></div>
        <div class="kpi"><span>Top3 率</span><b>${pct(o.top3Rate)}</b><span>分母 = 有效且有名次</span></div>
        <div class="kpi"><span>首推率</span><b>${pct(o.top1Rate)}</b><span>平均名次 ${o.avgRank ?? '—'}</span></div>
      </div>
      ${ex.failed || ex.quotaBlocked ? `<p style="font-size:11px;color:var(--warn);margin-top:10px">采集失败 ${ex.failed ?? 0} 次、配额拦截 ${ex.quotaBlocked ?? 0} 次,均不计入指标分母。</p>` : ''}
      </section>`;
    }
    if (key === 'layers' && p.questionLayers?.length) {
      const rows = p.questionLayers
        .map(
          (q) => `<tr><td>${esc(q.text)}</td><td>${q.type === 'ranking' ? '排名词' : '口碑词'}</td>
          <td>${q.layer ? `<span class="tag">${esc(q.layer)}</span>` : '—'}</td></tr>`,
        )
        .join('');
      return `<section><h2>位次表现(问题分层)</h2><table>
        <thead><tr><th>监控问题</th><th>类型</th><th>分层</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }
    if (key === 'competitors' && p.competitors?.length) {
      const rows = p.competitors
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td>${c.mentions}</td><td>${pct(c.mentionRate)}</td><td>${pct(c.top3Rate)}</td></tr>`,
        )
        .join('');
      return `<section><h2>竞品格局(同批查询同口径)</h2><table>
        <thead><tr><th>竞品</th><th>提及次数</th><th>提及率</th><th>Top3 率</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }
    if (key === 'reputation' && p.reputation) {
      const weak = (p.reputation.weaknesses ?? [])
        .map((w) => `<span class="tag" style="margin-right:6px">${esc(w.term)} × ${w.runs}</span>`)
        .join('');
      return `<section><h2>口碑摘要</h2>
        <p style="font-size:13px;margin:0 0 8px">情绪得分 <b style="font-size:18px">${p.reputation.sentimentScore ?? '—'}</b>
        <span style="color:#8a877e;font-size:12px">(口碑词有效回答 ${p.reputation.runs} 条)</span></p>
        ${weak ? `<p style="font-size:12px">待攻印象:${weak}</p>` : ''}</section>`;
    }
    if (key === 'citations' && p.citations) {
      const top = (p.citations.top ?? [])
        .map((c) => `<span class="tag" style="margin-right:6px">${esc(c.domain)} · ${c.hits}</span>`)
        .join('');
      return `<section><h2>引用源概况</h2>
        <p style="font-size:13px;margin:0 0 8px">总被引 <b>${p.citations.total}</b> 条 · 自有域名
        <b>${p.citations.owned}</b> 条 · 占比 <b>${pct(p.citations.ownedShare)}</b></p>
        ${top ? `<p style="font-size:12px">高频信源:${top}</p>` : ''}</section>`;
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
