import type { Page, Locator } from 'playwright-core';

import type { AskStatus, EngineId, RawCitation } from '@geo/shared';
import type { AskOptions, AskResult, EngineAdapter, SessionContext } from '../types';
import { ENGINE_SITES, siteConfigOf, type EngineSiteConfig } from './sites';

export type { EngineSiteConfig } from './sites';
export { ENGINE_SITES, siteConfigOf } from './sites';

export const WEB_ADAPTER_SCHEMA_VERSION = 'web-dom-v1';

/** ask 结果里 needsLogin=true 表示账号态失效,应把档案置 login_required 并人工重登。 */
export function needsLoginOf(result: AskResult): boolean {
  return result.engineMeta?.needsLogin === true;
}

const stripEchoNoise = (s: string) => normalizeTextLite(s.replace(/\s+/g, ''));

/** 基线对比归一:仅去空白(流式输出的换行抖动不影响对比;内容才是身份)。 */
const normalizeForDiff = (s: string) => s.replace(/\s+/g, '');

/** 轻量归一(仅采集端回声判定用):去标点/空白 + 小写。 */
function normalizeTextLite(s: string): string {
  return s
    .toLowerCase()
    .replace(/[?？!！。,，.、:：;；"'“”‘’()（）\[\]【】——\-—…·\s]/g, '');
}

/**
 * 回声判定(docs/04 §2.1 采集防污染):抓到的"回答"≈问题原文 = 输入气泡被当成回答
 * (实测豆包游客态:请求被静默拦截时,聊天流里最长文本是用户输入回显)。
 * 回声不是有效样本 → 调用方按失败收口并触发人工登录,不得计入口径。
 */
export function isEchoOfQuestion(answer: string, question: string): boolean {
  const a = stripEchoNoise(answer);
  const q = stripEchoNoise(question);
  if (!a || !q) return false;
  if (a === q) return true;
  // 回显可能携带少量站点噪声(时间戳/建议词):答案显著短于问题且被问题包含,同判为回声
  return a.length <= q.length + 8 && q.includes(a);
}

/** 登录态检测(适配器与人工登录编排共用)。判定顺序:
 * ① 正向信号:站点配置的登录 Cookie(如 doubao sessionid / wenxin BDUSS)存在 → 已登录
 *    (部分站点登录后页面仍有残留"登录"文案,Cookie 是最可靠的正向信号);
 * ② URL 命中登录页模式(如 deepseek 强制跳 /sign_in)→ 未登录;
 * ③ 任一未登录指示可见 → 未登录;
 * ④ 都不命中 → 未知(null,由调用方结合 requireLoginCookie 决定)。 */
export async function checkLogin(
  page: Page,
  site: EngineSiteConfig,
): Promise<{ loggedIn: boolean | null; hint: string | null }> {
  if (site.loggedInCookieHints?.length) {
    try {
      const cookies = await page.context().cookies(page.url());
      const hit = cookies.find((c) =>
        site.loggedInCookieHints!.some((h) => c.name.toLowerCase() === h.toLowerCase()),
      );
      if (hit) return { loggedIn: true, hint: `cookie:${hit.name}` };
    } catch {
      // Cookie 读取失败:继续负向判定
    }
  }
  const currentUrl = page.url();
  for (const pattern of site.loginUrlPatterns) {
    if (currentUrl.includes(pattern)) {
      return { loggedIn: false, hint: `url:${pattern}` };
    }
  }
  for (const hint of site.loginHints) {
    try {
      if (await page.locator(hint).first().isVisible({ timeout: 500 })) {
        return { loggedIn: false, hint };
      }
    } catch {
      // 选择器不适用当前页面:继续下一个指示
    }
  }
  // 无未登录指示 ≠ 确定已登录(页面结构变化时保守放行,由采集结果暴露问题)
  return { loggedIn: null, hint: null };
}

/** 提问输入框可用性:未登录指示消失 + 输入框可见,才认定登录成功(人工登录编排的成功判据)。 */
export async function hasVisibleInput(page: Page, site: EngineSiteConfig): Promise<boolean> {
  for (const sel of site.inputSelectors) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 500 })) return true;
    } catch {
      // 尝试下一个输入框候选
    }
  }
  return false;
}

/**
 * 网页端 DOM 采集适配器(docs/04 §2.1 路线 A,实验性):
 * 会话(登录态)由 SessionBroker 持久化,本适配器只负责:导航 → 未登录检测 →
 * 提问输入/发送 → 完成判定(停止控件消失 + 文本稳定窗口)→ 答案与引用结构化抽取。
 * 页面改版 = 更新 {@link EngineSiteConfig} 并升 schemaVersion,历史数据可解释(docs/04 §2)。
 */
export class DomWebAdapter implements EngineAdapter {
  readonly surface = 'web' as const;
  readonly strategy = 'dom' as const;
  readonly schemaVersion = WEB_ADAPTER_SCHEMA_VERSION;

  constructor(
    readonly engine: EngineId,
    private readonly site: EngineSiteConfig = siteConfigOf(engine),
  ) {}

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `dom-web:${this.site.displayName}(选择器链 ${this.site.inputSelectors.length} 组,实验性)` };
  }

  async ask(ctx: SessionContext, question: string, opts?: AskOptions): Promise<AskResult> {
    const queuedAt = new Date().toISOString();
    const page = ctx.page as Page | undefined;
    if (!page) {
      return this.fail('browser 模式需要 SessionHandle.page(connectOverCDP 或本地代理注入)', queuedAt);
    }
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    // 网络引用收割器(docs/04 §2.1 补充通路):挂到整个 ask 生命周期,
    // 从 JSON/SSE 响应载荷中提取引用来源(元宝/豆包正文不渲染引用链接,实测教训)
    const netHarvest = attachNetCitationHarvester(page, this.engine);
    try {
      await page.goto(this.site.chatUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.site.navigationTimeoutMs,
      });
      await page.waitForTimeout(1_500);
      // SPA 挂载等待:输入框就绪再提问,否则输入会打在未初始化的编辑器上(豆包实测)。
      // 代理出口增加往返延迟,水合更慢——等待窗口放大到 30s
      for (const sel of this.site.inputSelectors) {
        const ready = await page
          .waitForSelector(sel, { state: 'visible', timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (ready) break;
      }

      const login = await checkLogin(page, this.site);
      // 未登录:有正式登录态要求的站点直接失败(账号置 login_required);
      // 游客可提问的站点(如豆包)降级为游客态继续采集,不阻断
      if (login.loggedIn === false && !this.site.guestAllowed) {
        return {
          status: 'failed',
          answerText: '',
          rawHtml: null,
          citations: [],
          timing: this.timing(queuedAt),
          engineMeta: {
            error: 'needs_login',
            needsLogin: true,
            hint: login.hint,
            profileKey: ctx.profileKey,
            // 决定性遥测:此刻会话里的 Cookie 名单(注入是否生效一目了然)
            cookies: (await page.context().cookies(new URL(this.site.chatUrl).origin))
              .map((c) => c.name)
              .join(','),
          },
        };
      }
      const asGuest = login.loggedIn === false;

      const asked = await this.submitQuestion(page, question);
      if (!asked) {
        const bodyHead = (await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '')).slice(0, 80);
        // 输入框不可用的高频原因是未登录(游客落地页无输入框):非正登录证据时按
        // needs_login 收口 → 账号池置 login_required 引导人工登录,而不是误报页面改版
        const recheck = await checkLogin(page, this.site);
        if (recheck.loggedIn !== true) {
          return {
            status: 'failed',
            answerText: '',
            rawHtml: null,
            citations: [],
            timing: this.timing(queuedAt),
            engineMeta: {
              error: 'no_input_selector',
              needsLogin: true,
              hint: recheck.hint ?? `url=${page.url()} body="${bodyHead}"`,
              profileKey: ctx.profileKey,
              cookies: (await page.context().cookies(new URL(this.site.chatUrl).origin))
                .map((c) => c.name)
                .join(','),
            },
          };
        }
        return this.fail(`未找到可用的提问输入框(已登录,页面改版?需校准 inputSelectors;url=${page.url()} body="${bodyHead}")`, queuedAt);
      }

      const { main, text, timedOut } = await this.waitForAnswer(page, timeoutMs, question);
      const cleaned = text ? this.stripNoiseLines(text) : text;
      if (!cleaned) {
        return this.fail(timedOut ? '完成判定超时且无答案文本' : '回答容器为空(页面改版?需校准 answerSelectors)', queuedAt);
      }
      // 最短回答门槛(豆包实测:风控软拦截时"猜你想问"推荐位是唯一新增 DOM 内容,
      // 会被基线门控当回答收录;真实回答远长于此,按失败收口可被重采)
      const minChars = this.site.minAnswerChars ?? 0;
      if (!timedOut && minChars > 0 && cleaned.length < minChars) {
        return this.fail(`回答仅 ${cleaned.length} 字符,低于最小门槛 ${minChars}(疑似推荐位/风控拦截)`, queuedAt);
      }
      // 回声防污染(docs/04 §2.1):回答≈问题原文 = 输入回显被当回答(游客态被静默拦截的实测形态)
      if (isEchoOfQuestion(cleaned, question)) {
        return {
          status: 'failed',
          answerText: '',
          rawHtml: null,
          citations: [],
          timing: this.timing(queuedAt),
          engineMeta: {
            error: 'answer_echo_of_question',
            needsLogin: true,
            profileKey: ctx.profileKey,
            echo: cleaned.slice(0, 80),
          },
        };
      }

      // 原始页面快照(docs/04 §4 证据承诺):截断到 512KB,证据包"raw.html 永不存在"的
      // 空谈在此补齐;快照失败不影响回答正文(证据缺失 ≠ 采集失败)
      const rawHtml = await page
        .content()
        .then((html) => (html.length > 512 * 1024 ? Buffer.from(html.slice(0, 512 * 1024)).toString('utf8') : html))
        .catch(() => null);

      const domCitations = await this.extractCitations(page, main);
      // 网络收割收尾:轮询等待来源落地(豆包 SSE 带心跳,流关闭可能晚于答案稳定;
      // 元宝 detail 接口也在答案后 ~1-2s 才到)。拿到≥3条早退,最长 NET_CITATION_MAX_WAIT。
      if (this.site.netCitationAllow?.length) {
        const deadline = Date.now() + NET_CITATION_MAX_WAIT;
        while (Date.now() < deadline && netHarvest.citations.length < 3) {
          await page.waitForTimeout(1_000);
        }
      }
      const netCitations = netHarvest.citations;
      const merged: RawCitation[] = [];
      const seenUrls = new Set<string>();
      for (const c of [...domCitations, ...netCitations]) {
        const key = c.url.replace(/[?#].*$/, '');
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        merged.push(c);
        if (merged.length >= MAX_CITATIONS) break;
      }

      return {
        status: 'ok_with_answer' as AskStatus,
        answerText: cleaned,
        rawHtml,
        citations: merged,
        timing: this.timing(queuedAt),
        engineMeta: { mode: 'dom', profileKey: ctx.profileKey, timedOut, guest: asGuest, netCites: netCitations.length },
      };
    } catch (err) {
      return this.fail((err as Error).message, queuedAt);
    } finally {
      netHarvest.detach();
    }
  }

  /** 依次尝试输入框候选与发送按钮;contenteditable 用逐字注入触发真实输入事件,
   *  提交后以"输入框已清空"为成功信号,未清空再点发送/回车重试一轮。 */
  private async submitQuestion(page: Page, question: string): Promise<boolean> {
    for (const sel of this.site.inputSelectors) {
      const input = page.locator(sel).first();
      try {
        if (!(await input.isVisible({ timeout: 800 }))) continue;
        await input.click({ timeout: 3_000 });
        await this.typeInto(page, input, question);
      } catch {
        continue;
      }
      for (const attempt of [1, 2]) {
        await page.waitForTimeout(800); // 输入事件落地缓冲(诊断实测:立即回车会丢提交)
        for (const send of this.site.submitSelectors) {
          try {
            const btn = page.locator(send).first();
            if (await btn.isVisible({ timeout: 500 })) {
              await btn.click({ timeout: 3_000 });
              break;
            }
          } catch {
            // 尝试下一个发送候选
          }
        }
        await page.keyboard.press('Enter');
        // 提交成功信号:输入框内容被清空(站点发送后都会清空输入区)
        await page.waitForTimeout(1_200);
        const remaining = await input.innerText({ timeout: 1_000 }).catch(() => '');
        if (!remaining.trim()) return true;
        if (attempt === 1) await this.typeInto(page, input, question); // 重新填入再试
      }
      return false; // 此输入框提交失败:换下一个候选
    }
    return false;
  }

  /**
   * contenteditable 输入实测(qianwen/doubao):fill/type 的合成事件不被站点输入组件识别,
   * 必须 keyboard.insertText(浏览器级输入事件,元素需已聚焦)。
   * ⚠ 不做回显校验回退:豆包输入框 innerText 读不出插入文本,误回退成 fill 会覆盖有效输入。
   */
  private async typeInto(page: Page, input: Locator, text: string): Promise<void> {
    await input.fill('', { timeout: 3_000 }).catch(() => undefined);
    try {
      await page.keyboard.insertText(text);
    } catch {
      await input.fill(text, { timeout: 3_000 }).catch(() => undefined);
    }
  }

  /**
   * 完成判定(docs/04 §2.1):停止生成控件消失 + 主回答文本连续 stableMs 无新增。
   * 主回答 = 命中容器中文本最长者(推荐列表/建议芯片/引用卡都更短,不选);
   * 返回 timedOut=true 表示到达 ask 预算(可能有部分文本,按 ok_with_answer 收录)。
   *
   * 基线门控(元宝实测教训):页面常驻容器(侧栏菜单等)在提交前就有稳定长文本,
   * "最长且稳定"会被侧栏骗过 → 提交后立即快照全页候选文本,只有包含基线之外
   * "新增内容"的容器才有资格成为回答(侧栏永不新增 → 永不合格)。
   */
  private async waitForAnswer(
    page: Page,
    timeoutMs: number,
    question: string,
  ): Promise<{ main: Locator | null; text: string | null; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    // 基线快照:提交完成瞬间的全页候选文本(去空白归一),回答必须是基线之外的新增内容
    const baseline = new Set<string>();
    for (const c of await this.findAnswerCandidates(page)) {
      const t = normalizeForDiff(c.text);
      if (t) baseline.add(t.slice(0, 400));
    }
    let lastText = '';
    let lastMain: Locator | null = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const candidates = await this.findAnswerCandidates(page);
      // 活跃候选:文本显著超出基线(新增内容),按长度取最长者为当前主回答
      let main: Locator | null = null;
      let text = '';
      for (const c of candidates) {
        if (!this.isNewCandidateText(c.text, baseline)) continue;
        if (c.text.length > text.length) {
          text = c.text;
          main = c.locator;
        }
      }
      const trimmed = text.trim();
      const generating = await this.isGenerating(page);
      const now = Date.now();
      // 输入回显不计为候选回答:游客态请求被静默拦截时,聊天流里最长文本是问题回显,
      // 继续等待真实回答流出;直到超时仍只有回显 → 由 ask() 的回声检查按失败收口
      if (trimmed && !generating && !isEchoOfQuestion(trimmed, question)) {
        if (trimmed === lastText) {
          if (stableSince && now - stableSince >= this.site.completionStableMs) {
            return { main, text: trimmed, timedOut: false };
          }
          stableSince = stableSince || now;
        } else {
          stableSince = now;
        }
      }
      if (trimmed) {
        lastText = trimmed;
        lastMain = main;
      }
      await page.waitForTimeout(500);
    }
    // 超时:只有"新增内容"的部分文本才收录(按 ok_with_answer);从未出现新增内容
    // → 返回 null 由 ask() 按失败收口,而不是把侧栏常驻文本误录为回答(元宝实测教训)
    return { main: lastMain, text: lastText || null, timedOut: true };
  }

  /** 基线对比:候选文本是否为基线之外的新增内容(侧栏等常驻容器返回 false)。 */
  private isNewCandidateText(text: string, baseline: Set<string>): boolean {
    const norm = normalizeForDiff(text);
    if (norm.length < 30) return false; // 过短容器(芯片/按钮组)不作回答候选
    return !baseline.has(norm.slice(0, 400));
  }

  /** 全部回答候选(各选择器末尾若干容器,带文本):基线快照与活跃候选共用。 */
  private async findAnswerCandidates(page: Page): Promise<Array<{ locator: Locator; text: string }>> {
    const out: Array<{ locator: Locator; text: string }> = [];
    for (const sel of this.site.answerSelectors) {
      try {
        const nodes = page.locator(sel);
        const count = await nodes.count();
        if (count === 0) continue;
        const scan = Math.min(count, 10);
        for (let i = count - scan; i < count; i++) {
          const el = nodes.nth(i);
          const text = await el.innerText({ timeout: 800 }).catch(() => '');
          if (text.trim()) out.push({ locator: el, text });
        }
      } catch {
        // 尝试下一个容器候选
      }
    }
    return out;
  }

  /** 主回答定位(登录编排等外部复用):各候选选择器各扫最近若干个容器,取 innerText 最长者。 */
  async findMainAnswer(page: Page): Promise<Locator | null> {
    for (const sel of this.site.answerSelectors) {
      try {
        const nodes = page.locator(sel);
        const count = await nodes.count();
        if (count === 0) continue;
        let best: Locator | null = null;
        let bestLen = 0;
        const scan = Math.min(count, 10);
        for (let i = count - scan; i < count; i++) {
          const el = nodes.nth(i);
          const len = (await el.innerText({ timeout: 800 }).catch(() => '')).trim().length;
          if (len > bestLen) {
            bestLen = len;
            best = el;
          }
        }
        if (best) return best;
      } catch {
        // 尝试下一个容器候选
      }
    }
    return null;
  }

  private async isGenerating(page: Page): Promise<boolean> {
    for (const sel of this.site.stopSelectors) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 300 })) return true;
      } catch {
        // 尝试下一个停止控件候选
      }
    }
    return false;
  }

  /** 引用抽取(docs/04 §2.1):优先主回答容器内链接;过滤站内导航/协议/脚注噪声。 */
  private async extractCitations(page: Page, main: Locator | null): Promise<RawCitation[]> {
    const seen = new Set<string>();
    const out: RawCitation[] = [];
    const scopes: Array<{ label: string; locator: Locator }> = main
      ? [
          { label: 'answer', locator: main.locator('a[href^="http"]') },
          { label: 'page', locator: page.locator('a[href^="http"]') },
        ]
      : [{ label: 'page', locator: page.locator('a[href^="http"]') }];
    for (const { label, locator } of scopes) {
      let links;
      try {
        links = await locator.all();
      } catch {
        continue;
      }
      for (const link of links.slice(0, 40)) {
        try {
          const url = await link.getAttribute('href', { timeout: 500 });
          if (!url || !/^https:\/\//.test(url)) continue;
          const text = ((await link.innerText({ timeout: 300 }).catch(() => '')) || '').trim();
          // 噪声:站务/导航/超长文本链接不是引用源
          if (/协议|隐私|关于|帮助|反馈|下载|首页|登录|注册/.test(text) || text.length > 60) continue;
          const host = safeHost(url);
          if (!host || isEngineHost(host)) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          out.push({ url, title: (text || undefined)?.slice(0, 80) });
          if (out.length >= 10) return out;
        } catch {
          // 单个链接失败不影响整体抽取
        }
      }
      if (out.length > 0 && label === 'answer') return out; // 回答区内有真引用就不再全页兜底
    }
    return out;
  }

  /** 站点噪声行清理(如 wenxin 的工具调用状态行),逐行整行匹配移除。 */
  private stripNoiseLines(text: string): string {
    if (this.site.answerNoisePatterns.length === 0) return text.trim();
    const patterns = this.site.answerNoisePatterns.map((p) => new RegExp(p));
    const lines = text
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return t.length > 0 && !patterns.some((re) => re.test(t));
      });
    return lines.join('\n').trim();
  }

  private fail(error: string, queuedAt: string): AskResult {
    const now = new Date().toISOString();
    return {
      status: 'failed',
      answerText: '',
      rawHtml: null,
      citations: [],
      timing: { queuedAt, firstTokenAt: now, completedAt: now },
      engineMeta: { error },
    };
  }

  private timing(queuedAt: string) {
    const now = new Date().toISOString();
    return { queuedAt, firstTokenAt: now, completedAt: now };
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isEngineHost(host: string): boolean {
  return /doubao\.com|deepseek\.com|baidu\.com|aliyun\.com|tongyi\.com|tencent\.com|qq\.com/.test(host);
}

// ============ 网络引用收割(docs/04 §2.1 补充通路) ============
// 元宝/豆包实测:引用来源只出现在 API/SSE 载荷(文档对象带 url+title 字段),
// 页面 DOM 全程无 <a href>。收割器与站点解耦:对载荷做扁平 JSON 对象正则,
// 不绑定具体接口路径/结构,引擎改版只要字段名不换就持续有效。

const NET_CITATION_GRACE_MS = 2_500;
const NET_CITATION_MAX_WAIT = 12_000;
const MAX_CITATIONS = 10;
const MAX_NET_CITATIONS = 15;
const MAX_SNIFF_BYTES = 1_500_000;

/** 载荷级噪声:遥测/监控接口直接整包跳过(省文本读取开销)。 */
const RESPONSE_URL_SKIP = /monitor|beacon|telemetry|analytics|\/list\?|webid|tobid|abtest|settings\/v3|token/i;
/** 引用对象里可作来源 URL 的字段名(容忍 JSON-in-JSON 的 \" 转义残留)。 */
const NET_URL_KEY = /\\?"(?:url|web_url|jump_url|jumpUrl|open_url|link)\\?"\s*:\s*\\?"((?:https?)[^"\\]+)\\?"/i;
/** 站内资产/CDN(域名后缀匹配,mp.weixin.qq.com 等真实内容源不受影响)。 */
const NET_DENY_HOST_SUFFIX = [
  'bytedance.com', 'zijieapi.com', 'douyinpic.com', 'douyinvod.com', 'snssdk.com', 'feishucdn.com',
  'byteimg.com', 'bytetos.com', 'pstatp.com', 'zjcdn.com', 'yhgfb-cn-static.com', 'toutiaostatic.com',
  'bdstatic.com', 'bdimg.com',
  'myqcloud.com', 'beacon.qq.com', 'aida.qq.com', 'lizhicdn.search.qq.com', 'cdn-yb.icon.qq.com',
  'wxqcloud.qq.com.cn', 'wuying.com', 'aliyuncs.com',
];
const NET_ASSET_EXT = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|mp3|m3u8|ts|zip)([?#].*)?$/i;

interface NetCitationHarvester {
  citations: RawCitation[];
  detach(): void;
}

/** 在 ask 期间挂 response 监听,从 JSON/SSE 载荷提取引用来源;ask 结束必须 detach()。
 *  仅扫描 site.netCitationAllow 命中的接口(会话历史接口可能携带旧问题引用,必须隔离)。 */
function attachNetCitationHarvester(page: Page, engine: EngineId): NetCitationHarvester {
  const citations: RawCitation[] = [];
  const seen = new Set<string>();
  const allow = (ENGINE_SITES[engine]?.netCitationAllow ?? []).map((p) => new RegExp(p));
  const chatHost = safeHost(ENGINE_SITES[engine]?.chatUrl ?? '') ?? '';
  if (allow.length === 0) return { citations, detach: () => {} };
  const onResponse = (resp: { url(): string; headers(): Record<string, string>; body(): Promise<Buffer> }) => {
    try {
      const url = resp.url();
      if (!allow.some((re) => re.test(url))) return;
      const ct = resp.headers()['content-type'] ?? '';
      if (!/json|event-stream|text\/plain/i.test(ct)) return;
      if (RESPONSE_URL_SKIP.test(url)) return;
      if (citations.length >= MAX_NET_CITATIONS) return;
      // 不用 text():SSE 响应常缺 charset 声明,按默认 latin1 解码会把 UTF-8 中文变乱码
      void resp
        .body()
        .then((buf) => harvestCitationsFromPayload(buf.subarray(0, MAX_SNIFF_BYTES).toString('utf8'), citations, seen, chatHost))
        .catch(() => undefined);
    } catch {
      // 单个响应失败不影响整体收割
    }
  };
  page.on('response', onResponse as never);
  return {
    citations,
    detach: () => {
      try {
        page.off('response', onResponse as never);
      } catch {
        // 页面已关闭场景
      }
    },
  };
}

/** 从载荷提取引用对:JSON 直接树遍历(精确);SSE/文本用 URL-邻域窗口配对(兜底)。 */
function harvestCitationsFromPayload(
  body: string,
  out: RawCitation[],
  seen: Set<string>,
  chatHost: string,
): void {
  if (!body || out.length >= MAX_NET_CITATIONS) return;
  try {
    const parsed = JSON.parse(body);
    walkJsonForCitations(parsed, out, seen, chatHost);
    return;
  } catch {
    // 非完整 JSON(SSE 流/截断):走窗口兜底
  }
  // JSON-in-JSON(SSE data 行内嵌转义)先还原引号,再统一 unicode 转义的 &
  const text = body.replace(/\\"/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  for (const m of text.matchAll(new RegExp(NET_URL_KEY.source, 'gi'))) {
    if (out.length >= MAX_NET_CITATIONS) return;
    const window = text.slice(Math.max(0, m.index! - 300), (m.index ?? 0) + m[0].length + 300);
    pushNetCitation(m[1], window, out, seen, chatHost);
  }
}

/** 递归遍历已解析的 JSON,收集"对象里 url 类字段指向外部 http 页面"的引用对。 */
function walkJsonForCitations(node: unknown, out: RawCitation[], seen: Set<string>, chatHost: string): void {
  if (out.length >= MAX_NET_CITATIONS) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForCitations(item, out, seen, chatHost);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of ['url', 'web_url', 'jump_url', 'jumpUrl', 'open_url', 'link']) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      pushNetCitation(v, obj as Record<string, string>, out, seen, chatHost);
      break;
    }
  }
  for (const v of Object.values(obj)) walkJsonForCitations(v, out, seen, chatHost);
}

/** 校验并收录一条候选引用;window 用于 SSE 兜底路径上提取相邻 title。 */
function pushNetCitation(
  rawUrl: string,
  window: Record<string, unknown> | string,
  out: RawCitation[],
  seen: Set<string>,
  chatHost: string,
): void {
  if (out.length >= MAX_NET_CITATIONS) return;
  let host: string | null = null;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return;
  }
  if (!host || !host.includes('.')) return;
  if (host === chatHost) return;
  if (isEngineHost(host) && !host.endsWith('weixin.qq.com')) return; // 微信文章是元宝真实引用源
  if (NET_DENY_HOST_SUFFIX.some((d) => host === d || host.endsWith('.' + d))) return;
  if (NET_ASSET_EXT.test(rawUrl)) return;
  const key = rawUrl.replace(/[?#].*$/, '');
  if (seen.has(key)) return;
  seen.add(key);
  let title: string | undefined;
  if (typeof window === 'string') {
    title = window.match(/"(?:title|source|name)"\s*:\s*"([^"\\]{2,80})"/)?.[1];
  } else {
    for (const k of ['title', 'source', 'name']) {
      const v = window[k];
      if (typeof v === 'string' && v.length >= 2 && v.length <= 80) {
        title = v;
        break;
      }
    }
  }
  if (title) {
    // 豆包 SSE 经 CDP 常被 latin1 转码(UTF-8 字节被逐字节映射),URL 不受影响,标题需还原
    if (/[\u00c0-\u00ff][\u0080-\u00bf]/.test(title)) {
      try {
        const fixed = Buffer.from(title, 'latin1').toString('utf8');
        if (!fixed.includes('\uFFFD')) title = fixed;
      } catch {
        // 保留原标题
      }
    }
  }
  out.push({ url: rawUrl, title: title || undefined });
}
