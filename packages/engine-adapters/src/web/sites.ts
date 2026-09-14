import type { EngineId } from '@geo/shared';

/**
 * 五引擎站点配置(docs/04 §2.1 路线 A:DOM 采集)。
 * ⚠ 实验性:选择器为多级回退链,页面改版只发新 siteConfig/版本(docs/04 §7 失败模式手册);
 *   上线前按 docs/07 §13 PoC 逐引擎校准,字段以"任一命中即可"为语义。
 */
export interface EngineSiteConfig {
  engine: EngineId;
  displayName: string;
  /** 提问页(登录后落地页) */
  chatUrl: string;
  /** 未登录指示(任一可见 = 未登录;支持 :has-text());注意:支持游客提问的站点不可放"登录"按钮 */
  loginHints: string[];
  /** URL 含任一 pattern 即视为未登录(如强制跳转登录页;比按钮探测更稳) */
  loginUrlPatterns: string[];
  /** 提问输入框候选(依次尝试首个可见者;textarea 与 contenteditable 均可) */
  inputSelectors: string[];
  /** 发送按钮候选;全部失败回车兜底 */
  submitSelectors: string[];
  /** 回答容器候选(取最后一个 = 最新一轮回答) */
  answerSelectors: string[];
  /** "停止生成"控件(可见 = 仍在流式输出) */
  stopSelectors: string[];
  /** 回答文本的站点噪声行(整行匹配移除,如工具调用状态行);正则字符串 */
  answerNoisePatterns: string[];
  /** 回答文本稳定窗口(docs/04 §2.1 完成判定三条件之二) */
  completionStableMs: number;
  navigationTimeoutMs: number;
}

const BASE_COMPLETION_STABLE_MS = 3_000;
const BASE_NAV_TIMEOUT_MS = 30_000;

export const ENGINE_SITES: Record<EngineId, EngineSiteConfig> = {
  doubao: {
    engine: 'doubao',
    displayName: '豆包',
    chatUrl: 'https://www.doubao.com/chat/',
    loginHints: ['button:has-text("登录")', 'a:has-text("登录")', '[data-testid="login_button"]'],
    loginUrlPatterns: [],
    inputSelectors: [
      '[contenteditable="true"]',
      'textarea[data-testid="chat_text_input"]',
      '[data-testid="chat_text_input"]',
      'textarea[placeholder]',
    ],
    submitSelectors: ['[data-testid="send_button"]', 'button[type="submit"]', 'button:has-text("发送")'],
    answerSelectors: ['[data-testid="receive_message"]', 'div[class*="answer"]', 'div[class*="markdown-body"]'],
    stopSelectors: ['[data-testid="stop_button"]', 'button:has-text("停止")'],
    answerNoisePatterns: [],
    completionStableMs: BASE_COMPLETION_STABLE_MS,
    navigationTimeoutMs: BASE_NAV_TIMEOUT_MS,
  },
  deepseek: {
    engine: 'deepseek',
    displayName: 'DeepSeek',
    chatUrl: 'https://chat.deepseek.com/',
    // 实测(2026-09):未登录访问跳 /sign_in,页内登录控件非标准 button,以 URL 判定最稳
    loginHints: [],
    loginUrlPatterns: ['sign_in', 'login'],
    inputSelectors: ['#chat-input', 'textarea[id*="chat"]', 'textarea'],
    submitSelectors: ['div[class*="send"][role="button"]', 'button[type="submit"]'],
    answerSelectors: ['.ds-markdown', 'div[class*="markdown"]'],
    stopSelectors: ['div[class*="stop"]', 'button:has-text("停止")'],
    answerNoisePatterns: [],
    completionStableMs: BASE_COMPLETION_STABLE_MS,
    navigationTimeoutMs: BASE_NAV_TIMEOUT_MS,
  },
  wenxin: {
    engine: 'wenxin',
    displayName: '百度文心助手',
    // 实测(2026-09):yiyan.baidu.com → wenxin.baidu.com;未登录可直接提问并获真实回答
    // (登录按钮常驻侧栏,不是登录门槛,故 loginHints 置空——放"登录"会误杀游客采集)
    chatUrl: 'https://wenxin.baidu.com/',
    loginHints: [],
    loginUrlPatterns: ['passport.baidu.com'],
    inputSelectors: ['textarea', '#textarea', 'textarea[data-testid]'],
    submitSelectors: ['#sendBtn', 'button[data-testid="send"]', 'button:has-text("发送")'],
    answerSelectors: ['div[class*="answer"]', 'div[class*="markdown"]'],
    stopSelectors: ['button:has-text("停止")'],
    // 实测:回答头部混入工具调用状态行(wenxin 深度搜索 UI 文本)
    answerNoisePatterns: ['^调用工具$', '^品牌官方$', '^搜索全网\\d+篇资料$', '^已搜索\\d+篇资料$'],
    completionStableMs: BASE_COMPLETION_STABLE_MS,
    navigationTimeoutMs: BASE_NAV_TIMEOUT_MS,
  },
  qwen: {
    engine: 'qwen',
    displayName: '通义千问',
    // 实测(2026-09):tongyi.com → qianwen.com(品牌升级"千问");输入框为 contenteditable
    chatUrl: 'https://www.qianwen.com/',
    loginHints: ['button:has-text("登录")', 'a:has-text("登录")'],
    loginUrlPatterns: [],
    inputSelectors: ['[contenteditable="true"]', 'div[id*="chat-input"]', 'textarea'],
    // 实测(2026-09,登录态):发送按钮 aria-label="发送消息"
    submitSelectors: ['button[aria-label="发送消息"]', 'button:has-text("发送")', 'button[type="submit"]'],
    answerSelectors: ['div[class*="answer"]', 'div[class*="markdown"]'],
    stopSelectors: ['button:has-text("停止")'],
    answerNoisePatterns: [],
    completionStableMs: BASE_COMPLETION_STABLE_MS,
    navigationTimeoutMs: BASE_NAV_TIMEOUT_MS,
  },
  yuanbao: {
    engine: 'yuanbao',
    displayName: '腾讯元宝',
    chatUrl: 'https://yuanbao.tencent.com/chat',
    loginHints: ['button:has-text("登录")', 'a:has-text("登录")'],
    loginUrlPatterns: [],
    inputSelectors: ['[contenteditable="true"]', 'textarea'],
    submitSelectors: ['button:has-text("发送")', 'button[class*="send"]'],
    // 实测(2026-09,登录态):回答被拆成数十个 markdown 小块,须取整轮对话容器
    answerSelectors: ['div[class*="agent-dialogue"]', 'div[class*="agent-chat"]', 'div[class*="markdown"]'],
    stopSelectors: ['button:has-text("停止")'],
    answerNoisePatterns: [],
    completionStableMs: BASE_COMPLETION_STABLE_MS,
    navigationTimeoutMs: BASE_NAV_TIMEOUT_MS,
  },
};

/** 引擎站点配置只读视图(login 编排与 UI 展示共用)。 */
export function siteConfigOf(engine: EngineId): EngineSiteConfig {
  return ENGINE_SITES[engine];
}
