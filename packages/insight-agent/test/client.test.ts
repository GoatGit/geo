import { describe, expect, it } from 'vitest';
import { ChatError, chatCompletion, extractJsonText, isRetryable, joinUrl, maskKey } from '../src/client';

/** fetch stub:按脚本依次应答,记录请求。 */
function stubFetch(responses: Array<{ status?: number; body?: unknown; reject?: Error }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit) => {
    const script = responses[Math.min(calls.length, responses.length - 1)]!;
    calls.push({ url: String(url), init });
    if (script.reject) throw script.reject;
    return {
      ok: (script.status ?? 200) < 400,
      status: script.status ?? 200,
      text: async () => JSON.stringify(script.body ?? {}),
      json: async () => script.body ?? {},
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe('joinUrl / extractJsonText / maskKey', () => {
  it('端点拼接:基址自动补动作路径,已含完整路径不重复拼', () => {
    expect(joinUrl('https://x.com/v1', '/chat/completions')).toBe('https://x.com/v1/chat/completions');
    expect(joinUrl('https://x.com/v1/', '/chat/completions')).toBe('https://x.com/v1/chat/completions');
    expect(joinUrl('https://x.com/v1/chat/completions', '/chat/completions')).toBe('https://x.com/v1/chat/completions');
  });

  it('剥 markdown 栅栏', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it('maskKey:空串原样、短串全掩、长串留末 4 位', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('short')).toBe('***');
    expect(maskKey('sk-abcdefgh1234')).toBe('***1234');
  });
});

describe('chatCompletion 双协议', () => {
  const cfgOpenai = {
    protocol: 'openai' as const,
    endpoint: 'https://llm.example.com/compatible-mode/v1',
    apiKey: 'sk-test',
    model: 'qwen-max',
    timeoutMs: 1_000,
  };

  it('openai:Bearer 头 + json_object + system/user 消息', async () => {
    const { impl, calls } = stubFetch([{ body: { choices: [{ message: { content: '{"ok":true}' } }] } }]);
    const res = await chatCompletion(cfgOpenai, { system: 's', user: 'u' }, impl);
    expect(res.text).toBe('{"ok":true}');
    const { url, init } = calls[0]!;
    expect(url).toBe('https://llm.example.com/compatible-mode/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen-max');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('anthropic:x-api-key + anthropic-version + /v1/messages,取 text 块', async () => {
    const { impl, calls } = stubFetch([{ body: { content: [{ type: 'text', text: '{"ok":1}' }] } }]);
    const res = await chatCompletion(
      { ...cfgOpenai, protocol: 'anthropic', endpoint: 'https://gw.example.com', model: 'claude-x' },
      { system: 's', user: 'u' },
      impl,
    );
    expect(res.text).toBe('{"ok":1}');
    const { url, init } = calls[0]!;
    expect(url).toBe('https://gw.example.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('超时抛 ChatError(timeout),网络错误抛 network', async () => {
    const timeoutErr = new Error('aborted');
    timeoutErr.name = 'TimeoutError';
    const { impl } = stubFetch([{ reject: timeoutErr }]);
    await expect(chatCompletion(cfgOpenai, { system: 's', user: 'u' }, impl)).rejects.toMatchObject({ kind: 'timeout' });
    const { impl: impl2 } = stubFetch([{ reject: new Error('ECONNRESET') }]);
    await expect(chatCompletion(cfgOpenai, { system: 's', user: 'u' }, impl2)).rejects.toMatchObject({ kind: 'network' });
  });

  it('http 4xx/5xx 抛 ChatError(http) 带 status', async () => {
    const { impl } = stubFetch([{ status: 401, body: { error: 'bad key' } }]);
    await expect(chatCompletion(cfgOpenai, { system: 's', user: 'u' }, impl)).rejects.toMatchObject({
      kind: 'http',
      status: 401,
    });
  });

  it('空内容抛 empty', async () => {
    const { impl } = stubFetch([{ body: { choices: [{ message: { content: '' } }] } }]);
    await expect(chatCompletion(cfgOpenai, { system: 's', user: 'u' }, impl)).rejects.toMatchObject({ kind: 'empty' });
  });

  it('重试判定:5xx/429/超时可重试,4xx 不重试', () => {
    expect(isRetryable(new ChatError('http', 'oops', 500))).toBe(true);
    expect(isRetryable(new ChatError('http', 'oops', 429))).toBe(true);
    expect(isRetryable(new ChatError('http', 'oops', 400))).toBe(false);
    expect(isRetryable(new ChatError('timeout', 'oops'))).toBe(true);
    expect(isRetryable(new ChatError('network', 'oops'))).toBe(true);
  });
});
