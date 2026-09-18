import { describe, expect, it } from 'vitest';
import { DEFAULT_INSIGHT_AGENT_SETTINGS, type InsightAgentSettings } from '@geo/shared';
import { HttpException } from '@nestjs/common';
import { maskInsightAgent, resolveInsightAgentPatch } from '../src/admin/admin.controller';

const current = (): InsightAgentSettings => ({
  ...DEFAULT_INSIGHT_AGENT_SETTINGS,
  enabled: true,
  mode: 'llm',
  protocol: 'openai',
  endpoint: 'https://llm.example.com/v1',
  apiKey: 'sk-live-key-9999',
  model: 'qwen-max',
  timeoutMs: 8_000,
});

describe('maskInsightAgent(读取侧掩码)', () => {
  it('apiKey 永远掩码,其余字段原样', () => {
    const masked = maskInsightAgent(current());
    expect(masked.apiKey).toBe('***9999');
    expect(masked.endpoint).toBe(current().endpoint);
    expect(masked.model).toBe('qwen-max');
  });
});

describe('resolveInsightAgentPatch(写入合并语义)', () => {
  it('apiKey 空 / 掩码形态 = 保留原值;新值才覆盖', () => {
    expect(resolveInsightAgentPatch(current(), { apiKey: '' }).apiKey).toBe('sk-live-key-9999');
    expect(resolveInsightAgentPatch(current(), { apiKey: '***9999' }).apiKey).toBe('sk-live-key-9999');
    expect(resolveInsightAgentPatch(current(), { apiKey: ' sk-new-key-1 ' }).apiKey).toBe('sk-new-key-1');
  });

  it('http endpoint 拒绝;timeout 限幅;非法 mode/protocol 忽略', () => {
    expect(() => resolveInsightAgentPatch(current(), { endpoint: 'http://x.com/v1' })).toThrow(HttpException);
    expect(resolveInsightAgentPatch(current(), { timeoutMs: 99_000 }).timeoutMs).toBe(60_000);
    expect(resolveInsightAgentPatch(current(), { timeoutMs: 100 }).timeoutMs).toBe(2_000);
    const r = resolveInsightAgentPatch(current(), { mode: 'evil' as never, protocol: 'grpc' as never });
    expect(r.mode).toBe('llm');
    expect(r.protocol).toBe('openai');
  });

  it('启用 shadow/llm 但连接配置残缺 → 400', () => {
    const broken = { ...current(), apiKey: '' };
    expect(() => resolveInsightAgentPatch(broken, { mode: 'llm' })).toThrow(HttpException);
    expect(() => resolveInsightAgentPatch({ ...broken, apiKey: 'sk-x' }, { mode: 'llm' })).not.toThrow();
    // 关闭状态下残缺配置允许保存(先存后补)
    expect(() => resolveInsightAgentPatch({ ...broken, enabled: false }, { enabled: false })).not.toThrow();
  });
});
