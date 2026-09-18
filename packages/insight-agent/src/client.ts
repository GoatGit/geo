/**
 * 双协议 LLM 客户端(docs/09 §3):openai 兼容 / anthropic,fetch 直连,不引 SDK。
 * 只做"一次补全调用 + 文本提取 + 超时/重试",业务校验在 schema.ts。
 */

export type InsightProtocol = 'openai' | 'anthropic';

export type FetchLike = typeof fetch;

export interface ChatEndpoint {
  protocol: InsightProtocol;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface ChatResponse {
  text: string;
  latencyMs: number;
}

export type ChatErrorKind = 'timeout' | 'network' | 'http' | 'empty';

export class ChatError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

/** 允许重试的错误:超时/网络/5xx/429;其余 4xx(配置错、余额、鉴权)重试无意义。 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ChatError)) return false;
  if (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'empty') return true;
  if (err.kind === 'http') return err.status !== undefined && (err.status >= 500 || err.status === 429);
  return false;
}

/** 拼接端点:用户可能贴基址(/v1)也可能贴完整路径,已含动作路径则不重复拼。 */
export function joinUrl(endpoint: string, actionPath: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (base.endsWith(actionPath)) return base;
  return `${base}${actionPath}`;
}

/** 提取模型输出文本,剥掉常见的 markdown 代码栅栏(模型常把 JSON 包进 ```json)。 */
export function extractJsonText(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n\s*```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  return text;
}

export async function chatCompletion(
  cfg: ChatEndpoint,
  req: ChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResponse> {
  const startedAt = Date.now();
  const maxTokens = req.maxTokens ?? 2_000;
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  if (cfg.protocol === 'openai') {
    url = joinUrl(cfg.endpoint, '/chat/completions');
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
    body = {
      model: cfg.model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
  } else {
    url = joinUrl(cfg.endpoint, '/v1/messages');
    headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: 0,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    };
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new ChatError('timeout', `llm timeout after ${cfg.timeoutMs}ms`);
    throw new ChatError('network', `llm network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const bodyText = (await res.text().catch(() => '')).slice(0, 300);
    throw new ChatError('http', `llm http ${res.status}: ${bodyText}`, res.status);
  }

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const text = payload && cfg.protocol === 'openai'
    ? (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content
    : (payload as { content?: Array<{ type?: string; text?: string }> })?.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new ChatError('empty', 'llm response has no text content');
  }
  return { text, latencyMs: Date.now() - startedAt };
}

/** apiKey 掩码:admin 读取侧统一出口,完整 key 永不回传前端。 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `***${key.slice(-4)}`;
}
