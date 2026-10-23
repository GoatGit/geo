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
  /** 用完即毁(幂等,可被 finally/兜底定时器/destroyAll 重复调用);Context 已回存登录态 */
  release(): Promise<void>;
}

/**
 * 会话登记(实现方通常是 Redis):进程崩溃/OOM/被杀时 finally 不会执行,
 * 只能靠这条持久登记在下次启动时把无人认领的远程会话找回来释放。
 */
export interface SessionRegistry {
  track(entry: SessionRegistryEntry): Promise<void>;
  /** 会话已确认释放后注销;释放失败必须保留,留给清扫重试。 */
  forget(sessionId: string): Promise<void>;
  /** 只返回登记时间早于 staleBefore 的会话:清扫据此避免误杀其他实例正在用的会话。 */
  listOlderThan(staleBefore: number): Promise<SessionRegistryEntry[]>;
}

export interface SessionRegistryEntry {
  sessionId: string;
  /** 会话创建时间(epoch ms) */
  createdAt: number;
  /** 用途:决定该会话的应用侧最长存活时间 */
  purpose?: 'collect' | 'login';
}

export interface SessionBroker {
  acquire(profile: SessionProfile): Promise<SessionHandle>;
  /** 优雅退出:关闭本代理解持有的全部本地浏览器进程(远程代理为 no-op)。 */
  destroyAll?(): Promise<void>;
  /** 无 handle 时按会话 ID 释放(进程重启后回收孤儿用)。 */
  releaseById?(sessionId: string): Promise<void>;
  /** 清扫超过应用侧最长存活时间、仍留在登记里的遗留会话;返回实际释放数。 */
  sweepStaleSessions?(): Promise<number>;
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
  /**
   * 应用侧会话最长存活(ms):到点无条件释放,兜住「调用方卡死/漏调 release」,
   * 避免 ManualRelease 会话按小时空烧。必须大于对应链路的正常时长(登录窗口/采集硬墙)。
   */
  sessionMaxAgeMs?: { login?: number; collect?: number };
  /** 会话登记(可选):用于崩溃/重启后回收孤儿会话。 */
  sessionRegistry?: SessionRegistry;
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
