import { createHash } from 'node:crypto';
import {
  BrokerError,
  type AgentBayConfig,
  type SessionBroker,
  type SessionHandle,
  type SessionProfile,
} from './types';

/**
 * AgentBay Browser Use 会话代理(docs/07 §4):
 * ① 创建会话(browser_latest 镜像,可绑 Browser Context 持久化账号态)
 * ② 初始化浏览器(BrowserOption:UA/视口/指纹/代理注入)
 * ③ 取 CDP 端点(get_endpoint_url → wss+token)
 * ④ release 销毁会话(Context 已回存)。
 *
 * ⚠ PoC 闸门(docs/07 §13):REST 路径以官方 SDK(wuying-agentbay-sdk,TS)为准,
 * W1-2 校准;本实现把端点形状收敛在 {@link AgentBayClient} 一处,替换成本最小。
 * `get_endpoint_url` 需 Pro/Ultra 权益包(并发 ≤200 会话)。
 */
export class AgentBaySessionBroker implements SessionBroker {
  private readonly client: AgentBayClient;

  constructor(config: AgentBayConfig) {
    this.client = new AgentBayClient(config);
  }

  async acquire(profile: SessionProfile): Promise<SessionHandle> {
    const sessionId = await this.client.createSession(profile.contextRef);
    try {
      await this.client.initializeBrowser(sessionId, profile);
      const cdpUrl = await this.client.getEndpointUrl(sessionId);
      return {
        sessionId,
        cdpUrl,
        imageId: this.client.config.imageId,
        release: async () => {
          await this.client.releaseSession(sessionId).catch(() => {
            /* release 失败不阻塞主流程;会话泄漏由 AgentBay 侧空闲回收兜底 */
          });
        },
      };
    } catch (err) {
      await this.client.releaseSession(sessionId).catch(() => undefined);
      throw err;
    }
  }
}

export class AgentBayClient {
  constructor(readonly config: AgentBayConfig) {
    if (!config.apiKey) throw new BrokerError('AGENTBAY_API_TOKEN is required');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    let res: Response;
    try {
      res = await fetch(`${this.config.apiEndpoint}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BrokerError(`agentbay request failed: ${path}`, undefined, (err as Error).message);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BrokerError(`agentbay ${method} ${path} -> ${res.status}`, res.status, detail);
    }
    return (await res.json()) as T;
  }

  createSession(contextRef?: string): Promise<string> {
    return this.call<{ sessionId: string }>('POST', '/api/v2/sessions', {
      imageId: this.config.imageId,
      regionId: this.config.regionId,
      contextId: contextRef,
      labels: { app: 'geolens' },
    }).then((r) => r.sessionId);
  }

  initializeBrowser(
    sessionId: string,
    profile: SessionProfile,
  ): Promise<void> {
    return this.call('POST', `/api/v2/sessions/${sessionId}/browser/initialize`, {
      fingerprint: profile.fingerprint,
      proxy: profile.proxyHint,
    }).then(() => undefined);
  }

  getEndpointUrl(sessionId: string): Promise<string> {
    return this.call<{ endpointUrl: string }>(
      'GET',
      `/api/v2/sessions/${sessionId}/browser/endpoint`,
    ).then((r) => r.endpointUrl);
  }

  releaseSession(sessionId: string): Promise<void> {
    return this.call('DELETE', `/api/v2/sessions/${sessionId}`).then(() => undefined);
  }
}

/** 账号指纹哈希(日志/证据只落哈希,不落原文,docs/07 §10)。 */
export function fingerprintHash(profileKey: string): string {
  return createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
}
