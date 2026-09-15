import { createHash, randomUUID } from 'node:crypto';
import {
  BrokerError,
  type AgentBayConfig,
  type SessionBroker,
  type SessionHandle,
  type SessionProfile,
} from './types';

/**
 * AgentBay Browser Use 会话代理(docs/07 §4):
 * ① CreateMcpSession(browser_latest 镜像)
 * ② InitBrowser(UA/指纹注入)
 * ③ GetCdpLink → CDP wss 端点
 * ④ ReleaseMcpSession 销毁。
 *
 * W1-2 已校准(docs/07 §13):端点为 POP RPC `agentbay.<region>.aliyuncs.com`,
 * Version 2025-05-06,authType=Anonymous——凭据以 `Authorization: Bearer <akm-key>`
 * 放在 form body(与官方 wuying-agentbay-sdk 一致);ak- KeyId 不能用于会话鉴权。
 */

const RPC_VERSION = '2025-05-06';

export class AgentBaySessionBroker implements SessionBroker {
  private readonly config: AgentBayConfig;

  constructor(config: AgentBayConfig) {
    if (!config.apiKey) throw new BrokerError('AGENTBAY_API_TOKEN is required');
    this.config = config;
  }

  async acquire(profile: SessionProfile): Promise<SessionHandle> {
    const auth = `Bearer ${this.config.apiKey}`;
    const regionId = this.config.regionId ?? 'cn-shanghai';
    const body: Record<string, string> = { Authorization: auth };

    const createRes = await this.rpc('CreateMcpSession', {
      ...body,
      ImageId: this.config.imageId,
      RegionId: regionId,
      Labels: JSON.stringify({ app: 'geolens' }),
    });
    const sessionId = strField(createRes, ['SessionId', 'sessionId']);
    if (!sessionId) {
      throw new BrokerError('agentbay create: no SessionId in response', undefined, JSON.stringify(createRes).slice(0, 300));
    }

    try {
      // 指纹注入;失败不阻断(无指纹采集仍可进行,证据链不受影响)
      await this.rpc('InitBrowser', {
        ...body,
        SessionId: sessionId,
        BrowserOption: JSON.stringify({ fingerprint: profile.fingerprint, proxy: profile.proxyHint }),
      }).catch((err) => {
        console.error('[agentbay] InitBrowser failed (non-fatal):', (err as Error).message);
        return undefined;
      });

      // 浏览器 CDP 端点必须走 GetCdpLink(9333 端口);
      // CreateMcpSession 的 WsUrl 是 MCP 内部通道(需 X-Access-Token),不能作为 cdpUrl
      const linkRes = await this.rpc('GetCdpLink', { ...body, SessionId: sessionId });
      const cdpUrl = strField(linkRes, ['Url', 'url', 'WsUrl', 'Link']);
      if (!cdpUrl) {
        throw new BrokerError('agentbay: no CDP url in GetCdpLink response', undefined, JSON.stringify(linkRes).slice(0, 300));
      }

      return {
        sessionId,
        cdpUrl,
        imageId: this.config.imageId,
        release: async () => {
          // 释放失败不阻塞主流程;AgentBay 侧空闲回收兜底
          await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId }).catch(() => undefined);
        },
      };
    } catch (err) {
      await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId }).catch(() => undefined);
      throw err;
    }
  }

  /** POP RPC:POST form,Anonymous + Bearer key 在 body(docs/07 §4 W1-2 校准)。 */
  private async rpc(action: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({
      Action: action,
      Version: RPC_VERSION,
      RegionId: this.config.regionId ?? 'cn-shanghai',
      Format: 'JSON',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SignatureNonce: randomUUID(),
      ...fields,
    });
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    let res: Response;
    try {
      res = await fetch(`${this.config.apiEndpoint}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BrokerError(`agentbay ${action} network error`, undefined, (err as Error).message);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BrokerError(`agentbay ${action} -> ${res.status}`, res.status, text.slice(0, 200));
    }
    if (json.Code && json.Code !== 'ok' && json.Code !== 'OK') {
      throw new BrokerError(`agentbay ${action} -> ${String(json.Code)}`, res.status, String(json.Message ?? '').slice(0, 200));
    }
    return (json.Data ?? json) as Record<string, unknown>;
  }
}

function strField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    // 嵌套 Data 再找一层
    const d = obj.Data;
    if (d && typeof d === 'object' && typeof (d as Record<string, unknown>)[k] === 'string') {
      return (d as Record<string, string>)[k];
    }
  }
  return undefined;
}

/** 账号指纹哈希(日志/证据只落哈希,不落原文,docs/07 §10)。 */
export function fingerprintHash(profileKey: string): string {
  return createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
}
