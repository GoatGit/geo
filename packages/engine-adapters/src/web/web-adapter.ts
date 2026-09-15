import type { Page, Locator } from 'playwright-core';

import type { AskStatus, EngineId, RawCitation } from '@geo/shared';
import type { AskOptions, AskResult, EngineAdapter, SessionContext } from '../types';
import { siteConfigOf, type EngineSiteConfig } from './sites';

export type { EngineSiteConfig } from './sites';
export { ENGINE_SITES, siteConfigOf } from './sites';

export const WEB_ADAPTER_SCHEMA_VERSION = 'web-dom-v1';

/** ask 结果里 needsLogin=true 表示账号态失效,应把档案置 login_required 并人工重登。 */
export function needsLoginOf(result: AskResult): boolean {
  return result.engineMeta?.needsLogin === true;
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
    try {
      await page.goto(this.site.chatUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.site.navigationTimeoutMs,
      });
      await page.waitForTimeout(1_500);
      // SPA 挂载等待:输入框就绪(最多 15s)再提问,否则输入会打在未初始化的编辑器上(豆包实测)
      for (const sel of this.site.inputSelectors) {
        const ready = await page
          .waitForSelector(sel, { state: 'visible', timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (ready) break;
      }

      const login = await checkLogin(page, this.site);
      if (login.loggedIn === false) {
        return {
          status: 'failed',
          answerText: '',
          rawHtml: null,
          citations: [],
          timing: this.timing(queuedAt),
          engineMeta: { error: 'needs_login', needsLogin: true, hint: login.hint, profileKey: ctx.profileKey },
        };
      }

      const asked = await this.submitQuestion(page, question);
      if (!asked) {
        return this.fail('未找到可用的提问输入框(页面改版?需校准 inputSelectors)', queuedAt);
      }

      const { main, text, timedOut } = await this.waitForAnswer(page, timeoutMs);
      const cleaned = text ? this.stripNoiseLines(text) : text;
      if (!cleaned) {
        return this.fail(timedOut ? '完成判定超时且无答案文本' : '回答容器为空(页面改版?需校准 answerSelectors)', queuedAt);
      }

      return {
        status: 'ok_with_answer' as AskStatus,
        answerText: cleaned,
        rawHtml: null, // DOM 路线归一正文为主;页面快照由证据层按需补拍
        citations: await this.extractCitations(page, main),
        timing: this.timing(queuedAt),
        engineMeta: { mode: 'dom', profileKey: ctx.profileKey, timedOut },
      };
    } catch (err) {
      return this.fail((err as Error).message, queuedAt);
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
   */
  private async waitForAnswer(
    page: Page,
    timeoutMs: number,
  ): Promise<{ main: Locator | null; text: string | null; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      const main = await this.findMainAnswer(page);
      const text = main ? await main.innerText({ timeout: 1_000 }).catch(() => '') : '';
      const trimmed = text.trim();
      const generating = await this.isGenerating(page);
      const now = Date.now();
      if (trimmed && !generating) {
        if (trimmed === lastText) {
          if (stableSince && now - stableSince >= this.site.completionStableMs) {
            return { main, text: trimmed, timedOut: false };
          }
          stableSince = stableSince || now;
        } else {
          stableSince = now;
        }
      }
      lastText = trimmed || lastText;
      await page.waitForTimeout(500);
    }
    return { main: null, text: lastText || null, timedOut: true };
  }

  /** 主回答定位:各候选选择器各扫最近若干个容器,取 innerText 最长者(实时 DOM,索引随流式变化)。 */
  private async findMainAnswer(page: Page): Promise<Locator | null> {
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
