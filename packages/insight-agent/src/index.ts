/**
 * InsightAgent(docs/09):LLM 判定层统一入口。
 * 职责边界:本包只做"LLM 结构化判定 + 配置解析 + 事件上报";
 * 降级(回落规则引擎)、落库、口径计算由调用方完成——本包判定失败时返回 null。
 */
import {
  DEFAULT_INSIGHT_AGENT_SETTINGS,
  type InsightAgentSettings,
  type MentionFactDraft,
} from '@geo/shared';
import { chatCompletion, ChatError, extractJsonText, isRetryable, type ChatEndpoint, type FetchLike } from './client';
import {
  buildClassifyPrompt,
  buildExpandPrompt,
  buildMentionPrompt,
  buildReputationPrompt,
  INSIGHT_PROMPT_VERSION,
  type MentionSubjectInput,
} from './prompts';
import {
  validateClassifyOutput,
  validateExpandOutput,
  validateMentionOutput,
  validateReputationOutput,
} from './schema';

export * from './client';
export * from './schema';
export * from './prompts';

/** LLM 判定事实的版本串(组合 parserVersion,docs/09 §7);规则路径沿用既有 'v1'。 */
export function insightParserVersion(protocol: string, model: string): string {
  return `insight@${INSIGHT_PROMPT_VERSION}+${protocol}/${model}`;
}

/** 生效配置:platform_settings 为主;库内从未保存过(等于默认值)时允许 env 引导(docs/09 §4.2)。 */
export function resolveInsightSettings(
  stored: InsightAgentSettings,
  env: NodeJS.ProcessEnv = process.env,
): InsightAgentSettings {
  const untouched =
    JSON.stringify({ ...stored, apiKey: '' }) === JSON.stringify({ ...DEFAULT_INSIGHT_AGENT_SETTINGS, apiKey: '' });
  if (!untouched) return stored;
  const merged: InsightAgentSettings = { ...stored };
  if (env.INSIGHT_AGENT_ENDPOINT) merged.endpoint = env.INSIGHT_AGENT_ENDPOINT.trim();
  if (env.INSIGHT_AGENT_API_KEY) merged.apiKey = env.INSIGHT_AGENT_API_KEY.trim();
  if (env.INSIGHT_AGENT_MODEL) merged.model = env.INSIGHT_AGENT_MODEL.trim();
  if (env.INSIGHT_AGENT_PROTOCOL === 'anthropic' || env.INSIGHT_AGENT_PROTOCOL === 'openai') {
    merged.protocol = env.INSIGHT_AGENT_PROTOCOL;
  }
  if (env.INSIGHT_AGENT_MODE === 'shadow' || env.INSIGHT_AGENT_MODE === 'llm') merged.mode = env.INSIGHT_AGENT_MODE;
  if (env.INSIGHT_AGENT_ENABLED === 'true') merged.enabled = true;
  return merged;
}

export interface InsightEvent {
  kind: 'call' | 'fallback' | 'invalid_partial';
  task: 'mention' | 'reputation' | 'classify' | 'expand';
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface MentionJudge extends MentionSubjectInput {
  mentioned: boolean;
  rank: number | null;
  confidence: number;
  excerpt: string;
}

export interface MentionJudgement {
  answerEmpty: boolean;
  judges: MentionJudge[];
  parserVersion: string;
}

export interface ReputationJudgement {
  sentiment: 'pos' | 'neu' | 'neg';
  confidence: number;
  impressions: Array<{ term: string; polarity: 'pos' | 'neg'; excerpt: string }>;
  parserVersion: string;
}

const MAX_RETRIES = 1;

export class InsightAgent {
  private readonly settings: InsightAgentSettings;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    settings: InsightAgentSettings;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    onEvent?: (e: InsightEvent) => void;
  }) {
    this.settings = resolveInsightSettings(opts.settings, opts.env);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onEvent = opts.onEvent ?? (() => undefined);
  }

  private readonly onEvent: (e: InsightEvent) => void;

  /** 是否具备发起调用的条件:开关开、模式非 rules、三项连接配置齐全。 */
  get usable(): boolean {
    const s = this.settings;
    return s.enabled && s.mode !== 'rules' && Boolean(s.endpoint && s.apiKey && s.model);
  }

  get mode(): InsightAgentSettings['mode'] {
    return this.settings.mode;
  }

  private endpointCfg(timeoutMs?: number): ChatEndpoint {
    const s = this.settings;
    return {
      protocol: s.protocol,
      endpoint: s.endpoint,
      apiKey: s.apiKey,
      model: s.model,
      // 上限 60s:GLM 对长回答的真实延迟 10-40s,旧 30s 钳制让配置的超时形同虚设
      // (mention/reputation 全量超时降级,实测教训);防呆上限只防配置写错量级
      timeoutMs: Math.min(timeoutMs ?? s.timeoutMs, 60_000),
    };
  }

  private async chatWithRetry(cfg: ChatEndpoint, system: string, user: string, task: InsightEvent['task']): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await chatCompletion(cfg, { system, user }, this.fetchImpl);
        this.onEvent({ kind: 'call', task, ok: true, latencyMs: res.latencyMs });
        return res.text;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ChatError && isRetryable(err))) break;
      }
    }
    this.onEvent({
      kind: 'fallback',
      task,
      ok: false,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private parseJson(text: string): unknown {
    return JSON.parse(extractJsonText(text));
  }

  /** T1 品牌识别:一次调用覆盖全部主体;空回答短路不调用;失败返回 null 由调用方回落规则。 */
  async judgeMention(input: {
    question: string;
    answerMarkdown: string;
    subjects: MentionSubjectInput[];
  }): Promise<MentionJudgement | null> {
    if (!this.usable) return null;
    const parserVersion = insightParserVersion(this.settings.protocol, this.settings.model);
    if (!input.answerMarkdown.trim()) {
      return {
        answerEmpty: true,
        judges: input.subjects.map((s) => ({ ...s, mentioned: false, rank: null, confidence: 1, excerpt: '' })),
        parserVersion,
      };
    }
    const { system, user } = buildMentionPrompt(input);
    let text: string;
    try {
      text = await this.chatWithRetry(this.endpointCfg(), system, user, 'mention');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = this.parseJson(text);
    } catch (err) {
      this.onEvent({ kind: 'fallback', task: 'mention', ok: false, error: `bad json: ${(err as Error).message}` });
      return null;
    }
    const validated = validateMentionOutput(parsed);
    if (!validated.ok) {
      this.onEvent({ kind: 'fallback', task: 'mention', ok: false, error: validated.errors.join('; ').slice(0, 300) });
      return null;
    }
    // 反幻觉:丢弃输入集之外的 key(计数上报);同 key 重复取首个
    const known = new Map(input.subjects.map((s) => [s.key, s]));
    const seen = new Set<string>();
    const judges: MentionJudge[] = [];
    let dropped = 0;
    for (const s of validated.value.subjects) {
      const def = known.get(s.key);
      if (!def) {
        dropped += 1;
        continue;
      }
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      judges.push({ ...def, mentioned: s.mentioned, rank: s.rank, confidence: s.confidence, excerpt: s.excerpt });
    }
    for (const def of input.subjects) {
      if (!seen.has(def.key)) judges.push({ ...def, mentioned: false, rank: null, confidence: 1, excerpt: '' });
    }
    if (dropped > 0) this.onEvent({ kind: 'invalid_partial', task: 'mention', ok: false, error: `${dropped} unknown keys dropped` });
    return { answerEmpty: validated.value.answerEmpty, judges, parserVersion };
  }

  /** T2 口碑分析:整体情绪(仅针对本品)+ 短语级印象词;失败返回 null。 */
  async judgeReputation(input: { brandName: string; answerText: string }): Promise<ReputationJudgement | null> {
    if (!this.usable) return null;
    if (!input.answerText.trim()) return null;
    const { system, user } = buildReputationPrompt(input);
    let text: string;
    try {
      text = await this.chatWithRetry(this.endpointCfg(), system, user, 'reputation');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = this.parseJson(text);
    } catch (err) {
      this.onEvent({ kind: 'fallback', task: 'reputation', ok: false, error: `bad json: ${(err as Error).message}` });
      return null;
    }
    const validated = validateReputationOutput(parsed);
    if (!validated.ok) {
      this.onEvent({ kind: 'fallback', task: 'reputation', ok: false, error: validated.errors.join('; ').slice(0, 300) });
      return null;
    }
    return { ...validated.value, parserVersion: insightParserVersion(this.settings.protocol, this.settings.model) };
  }

  /** 连通性探针(docs/09 §4.3 测试连接的底层):最小补全往返,返回耗时;失败抛错。 */
  async ping(timeoutMs?: number): Promise<number> {
    const startedAt = Date.now();
    await this.chatWithRetry(
      this.endpointCfg(timeoutMs),
      '你是连通性探针。只输出一个 JSON 对象。',
      '回复一个 JSON:{"ok":true}',
      'classify',
    );
    return Date.now() - startedAt;
  }

  /** T3 分类(API 同步路径,调用方限 3s 预算);失败返回 null。 */
  async classify(
    text: string,
    timeoutMs?: number,
  ): Promise<{ type: 'ranking' | 'reputation'; confidence: number; parserVersion: string } | null> {
    if (!this.usable) return null;
    const { system, user } = buildClassifyPrompt(text);
    let raw: string;
    try {
      raw = await this.chatWithRetry(this.endpointCfg(timeoutMs), system, user, 'classify');
    } catch {
      return null;
    }
    try {
      const validated = validateClassifyOutput(this.parseJson(raw));
      if (!validated.ok) return null;
      return { ...validated.value, parserVersion: insightParserVersion(this.settings.protocol, this.settings.model) };
    } catch {
      return null;
    }
  }

  /** T4 拓写(API 同步路径);失败返回 null。 */
  async expand(
    text: string,
    brandName: string,
    year: number,
    timeoutMs?: number,
  ): Promise<{ question: string; parserVersion: string } | null> {
    if (!this.usable) return null;
    const { system, user } = buildExpandPrompt(text, brandName, year);
    let raw: string;
    try {
      raw = await this.chatWithRetry(this.endpointCfg(timeoutMs), system, user, 'expand');
    } catch {
      return null;
    }
    try {
      const validated = validateExpandOutput(this.parseJson(raw));
      if (!validated.ok) return null;
      return { ...validated.value, parserVersion: insightParserVersion(this.settings.protocol, this.settings.model) };
    } catch {
      return null;
    }
  }
}

/**
 * LLM 判定 → MentionFactDraft(落库形态):纯函数,便于单测。
 * coRanked 保留既有口径:同一位次并列多个主体;evidence = 摘录(hitWord 用主体名,position 置 0 表 LLM 来源)。
 */
export function toMentionDrafts(
  judgement: MentionJudgement,
  base: { runId: string; brandId: number },
): MentionFactDraft[] {
  const rankCounts = new Map<number, number>();
  for (const j of judgement.judges) {
    if (j.mentioned && j.rank !== null) rankCounts.set(j.rank, (rankCounts.get(j.rank) ?? 0) + 1);
  }
  return judgement.judges.map((j) => ({
    runId: base.runId,
    brandId: base.brandId,
    subjectKind: j.kind as MentionFactDraft['subjectKind'],
    subjectKey: j.key,
    subjectName: j.name,
    mentioned: j.mentioned,
    rank: j.rank,
    coRanked: j.rank !== null && (rankCounts.get(j.rank) ?? 0) > 1,
    evidence: j.mentioned && j.excerpt ? { hitWord: j.name, snippet: j.excerpt.slice(0, 120), position: 0 } : null,
    parserVersion: judgement.parserVersion,
    confidence: j.mentioned ? j.confidence : 1,
  }));
}

/** 测试连接(docs/09 §4.3):最小补全往返;任何错误转 {ok:false} 供后台展示。 */
export async function testConnection(
  settings: InsightAgentSettings,
  fetchImpl?: FetchLike,
): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
  const agent = new InsightAgent({ settings, fetchImpl });
  const startedAt = Date.now();
  if (!agent.usable) {
    return { ok: false, latencyMs: 0, model: settings.model, error: '配置不完整:需要 endpoint/apiKey/model 且 mode 为 shadow 或 llm' };
  }
  try {
    const latencyMs = await agent.ping(Math.min(settings.timeoutMs, 10_000));
    return { ok: true, latencyMs, model: settings.model };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: settings.model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
