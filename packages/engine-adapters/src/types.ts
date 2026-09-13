import type { AskStatus, EngineId, RawCitation, Surface } from '@geo/shared';

export type { AskStatus, RawCitation };

/** 引擎会话上下文:Worker 经 SessionBroker 拿到 CDP 端点后注入(browser 模式)。 */
export interface SessionContext {
  mode: 'mock' | 'browser';
  /** browser 模式:playwright Page(connectOverCDP 之后);mock 模式为空 */
  page?: unknown;
  fingerprint: Record<string, unknown>;
  proxyHint?: string;
  /** 会话粘性标识(账号档案 ID,docs/04 §3.2) */
  profileKey: string;
}

/** docs/04 §2 AskResult:引用"能取多少取多少",归一化正文 + 原始页面留给证据层。 */
export interface AskResult {
  status: AskStatus;
  /** 回答正文(Markdown 归一化) */
  answerText: string;
  /** 网页端页面归档(MHTML/HTML);mock 模式为 null */
  rawHtml: string | null;
  citations: RawCitation[];
  timing: { queuedAt: string; firstTokenAt: string; completedAt: string };
  /** 引擎侧元数据(接口路线 B 捕获的响应摘要等) */
  engineMeta?: Record<string, unknown>;
}

export interface AdapterHealth {
  ok: boolean;
  detail?: string;
}

/**
 * 引擎适配器(docs/04 §2):
 * - 每个适配器带 schemaVersion,页面/接口改版只发新版本;QueryRun 记录所用版本
 * - strategy=network-capture(路线 B,优先)| dom(路线 A,兜底)| mock-replay(dev/CI)
 * - 真实引擎适配器在 AgentBay PoC(docs/07 §13)验证 Network 域抓包后落地;
 *   本包先交付接口、注册表与 Mock 回放,保证全链路可开发可测试。
 */
export interface EngineAdapter {
  engine: EngineId;
  surface: Surface;
  schemaVersion: string;
  strategy: 'network-capture' | 'dom' | 'mock-replay';
  ask(ctx: SessionContext, question: string, opts?: AskOptions): Promise<AskResult>;
  healthCheck(): Promise<AdapterHealth>;
}

export interface AskOptions {
  /** 完成判定超时(docs/04 §2.1:流停止 + DOM 稳定窗口) */
  timeoutMs?: number;
  signal?: AbortSignal;
}
