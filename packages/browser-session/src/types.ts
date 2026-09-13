/** 会话代理接口(docs/07 §4.2):Worker 不感知浏览器在哪,实现可整体替换(降级红线)。 */

export interface SessionProfile {
  /** 账号档案唯一键(粘性三元组:账号→Context→出口,docs/04 §3.2) */
  profileKey: string;
  /** AgentBay Browser Context(Cookie/登录态跨会话持久化) */
  contextRef?: string;
  fingerprint: Record<string, unknown>;
  proxyHint?: string;
}

export interface SessionHandle {
  sessionId: string;
  /** CDP WebSocket 端点(wss + token,worker 用 playwright-core connectOverCDP) */
  cdpUrl: string;
  imageId?: string;
  /** 用完即毁;Context 已回存登录态 */
  release(): Promise<void>;
}

export interface SessionBroker {
  acquire(profile: SessionProfile): Promise<SessionHandle>;
}

export interface AgentBayConfig {
  apiEndpoint: string;
  apiKey: string;
  imageId: string;
  regionId?: string;
  /** 会话操作超时(冷启动预算 ≤15s,PoC 校准 docs/07 §13) */
  timeoutMs?: number;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}
