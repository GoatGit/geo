/**
 * 收码站 HTTP 客户端(0019 豆包批量登录):
 * 收码页面(app.js)本身只是薄壳,取号/收码全部走四个 HTTP 接口,
 * 系统直连接口即可完成自动化,无需驱动浏览器操作收码页。
 *
 * 接口(均为相对路径,挂在收码站域名下):
 * - GET  /api/session?t=TOKEN&slot=N        取当前手机号与会话状态
 * - POST /api/session/start  {t, slot}      「我已发送」开始收取(豆包发码后调用)
 * - POST /api/session/poll   {t, slot}      轮询会话状态与验证码
 * - POST /api/session/reset-timer {t, slot} 重置等待倒计时
 *
 * 会话状态机:created(已分配号码)→ waiting(已开始收取)→ completed(code 字段含验证码)
 *             replacing(收码站自动换号,需用新号重发)  / failed(号码不可用)
 */

export interface SmsSession {
  status: 'created' | 'waiting' | 'replacing' | 'completed' | 'failed' | string;
  phone?: string;
  attempt?: number;
  max_attempts?: number;
  code?: string;
  slot?: number;
  can_reset_timer?: boolean;
  message?: string;
}

/** 从收码链接提取 token:https://host/?t=TOKEN → TOKEN。 */
export function smsTokenFromLink(link: string): string | null {
  const m = /[?&]t=([A-Za-z0-9_-]+)/.exec(link.trim());
  return m?.[1] ?? null;
}

export class SmsLinkClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://sms.yangsea.top',
  ) {}

  private async call<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'content-type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text.slice(0, 120);
      try {
        const parsed = JSON.parse(text) as { detail?: unknown; message?: string };
        detail = typeof parsed.detail === 'string' ? parsed.detail : parsed.message ?? detail;
      } catch { /* 非 JSON 错误体 */ }
      throw new Error(`收码站请求失败(HTTP ${resp.status}):${detail}`);
    }
    return JSON.parse(text) as T;
  }

  async getSession(slot = 0): Promise<SmsSession> {
    return this.call<SmsSession>(`/api/session?t=${encodeURIComponent(this.token)}&slot=${slot}&probe=0`);
  }

  async startCollect(slot = 0): Promise<SmsSession> {
    return this.call<SmsSession>('/api/session/start', { method: 'POST', json: { t: this.token, slot } });
  }

  async poll(slot = 0): Promise<SmsSession> {
    return this.call<SmsSession>('/api/session/poll', { method: 'POST', json: { t: this.token, slot } });
  }
}
