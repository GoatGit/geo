/** 会话代理接口(docs/07 §4.2):Worker 不感知浏览器在哪,实现可整体替换(降级红线)。 */

export interface SessionProfile {
  /** 账号档案唯一键(粘性三元组:账号→Context→出口,docs/04 §3.2) */
  profileKey: string;
  /** AgentBay Browser Context(Cookie/登录态跨会话持久化);本地代理为 profile 目录标记 */
  contextRef?: string;
  fingerprint: Record<string, unknown>;
  proxyHint?: string;
  /** 会话用途:login=人工登录(headed 常驻等待操作者),collect=采集(默认) */
  purpose?: 'collect' | 'login';
}

export interface SessionHandle {
  sessionId: string;
  /** CDP WebSocket 端点(wss + token,worker 用 playwright-core connectOverCDP) */
  cdpUrl: string;
  imageId?: string;
  /** 登录态绑定的持久化 Context ID(成功后写回 profile.contextRef,采集复用) */
  contextId?: string;
  /** 本地代理直接注入的 Page(免去 connectOverCDP);远程代理为空 */
  page?: unknown;
  /** 用完即毁;Context 已回存登录态 */
  release(): Promise<void>;
}

export interface SessionBroker {
  acquire(profile: SessionProfile): Promise<SessionHandle>;
  /** 优雅退出:关闭本代理解持有的全部本地浏览器进程(远程代理为 no-op)。 */
  destroyAll?(): Promise<void>;
}

export interface AgentBayConfig {
  apiEndpoint: string;
  apiKey: string;
  imageId: string;
  regionId?: string;
  /** Context 同步目录(沙箱内绝对路径,默认 /home/wuying/workspace):浏览器登录态持久化的载体 */
  contextPath?: string;
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
