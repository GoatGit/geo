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

/** Context 同步目录(沙箱内绝对路径):浏览器登录态随该目录与 Context 双向同步。 */
const DEFAULT_CONTEXT_PATH = '/home/wuying/workspace';

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

    // 登录态持久化(docs/04 §3.1):按 profileKey 取/建 AgentBay Context,
    // 会话绑定该 Context 后,浏览器 Cookie/localStorage 随 Context 跨会话保存
    let contextId: string | undefined;
    try {
      const ctxRes = await this.rpc('GetContext', {
        ...body,
        Name: contextNameFor(profile.profileKey),
        AllowCreate: 'true',
      });
      // GetContext 响应中 Context ID 位于 Id 字段(形如 SdkCtx-xxx;XML/JSON 双形态均兼容)
      contextId = strField(ctxRes, ['Id', 'ContextId', 'contextId']) ?? undefined;
    } catch (err) {
      console.error('[agentbay] GetContext failed (降级为无 Context 会话):', (err as Error).message);
    }

    // 创建会话:禁止直传 ContextId —— 该传参方式已被平台废弃
    // (实测返回 Context.AccessDenied "tenantId not in whitelist"),持久化改走第③步 BindContexts。
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

    // ③ 显式绑定 Context(2025-05+ 协议:BindContexts + PersistenceDataList)。
    // 失败一律降级为无 Context 会话(登录/采集照常,仅登录态不跨会话保留)。
    if (contextId) {
      try {
        await this.bindContext(sessionId, contextId);
      } catch (err) {
        console.warn(
          `[agentbay] Context 绑定失败(${(err as Error).message}),降级为无 Context 会话:登录态不跨会话保留`,
        );
        contextId = undefined;
      }
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
        contextId,
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

  /**
   * 显式绑定 Context 到会话(2025-05+ 协议,替代废弃的 CreateMcpSession ContextId 直传):
   * BindContexts(PersistenceDataList,元素 PascalCase:{ContextId, Path})→
   * 轮询 DescribeSessionContexts 直至登记可见(≤12s,超时非致命 —— 登记最终一致)。
   * 同一会话内一条 Path 只能绑定一个 Context(重复绑返回 PathAlreadyBound)。
   */
  private async bindContext(sessionId: string, contextId: string): Promise<void> {
    const body = { Authorization: `Bearer ${this.config.apiKey}` };
    const path = this.config.contextPath ?? DEFAULT_CONTEXT_PATH;
    await this.rpc('BindContexts', {
      ...body,
      SessionId: sessionId,
      PersistenceDataList: JSON.stringify([{ ContextId: contextId, Path: path }]),
    });
    for (let i = 0; i < 6; i++) {
      const res = await this.rpc('DescribeSessionContexts', { ...body, SessionId: sessionId });
      if (JSON.stringify(res).includes(contextId)) return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    console.warn('[agentbay] Context 绑定登记轮询超时(非致命,继续;持久化可能延迟生效)');
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
    // 同一网关对同一动作可能返回 JSON 或 XML(实测 GetContext 在 cn-hangzhou 返回 JSON、
    // 其他区域/版本为 XML),按首字符统一解析
    const parsed = text.trimStart().startsWith('{') ? parseJsonLoose(text) : parseXmlLoose(text);
    const code = String(parsed.Code ?? 'ok');
    if (code !== 'ok' && code !== 'OK' && code !== 'Success') {
      throw new BrokerError(`agentbay ${action} -> ${code}`, res.status, String(parsed.Message ?? '').slice(0, 200));
    }
    const data = (parsed.Data ?? parsed) as Record<string, unknown>;
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : parsed;
  }
}

/** 宽松 JSON 解析:失败抛错由调用方统一处理。 */
function parseJsonLoose(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BrokerError('agentbay response is not JSON', undefined, text.slice(0, 200));
  }
}

/** XML 响应 → 扁平键值:顶层 Code/Message/Success + Data 内的一级字段。 */
function parseXmlLoose(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const tag of ['Code', 'Message', 'Success', 'RequestId', 'HttpStatusCode']) {
    const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    if (m) out[tag] = m[1];
  }
  const dataBlock = text.match(/<Data>([\s\S]*?)<\/Data>/);
  if (dataBlock) {
    for (const m of dataBlock[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  }
  return out;
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

/** profileKey('profile:5')→ 合法 Context 名。 */
function contextNameFor(profileKey: string): string {
  return `geo-${profileKey.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`;
}

/** 账号指纹哈希(日志/证据只落哈希,不落原文,docs/07 §10)。 */
export function fingerprintHash(profileKey: string): string {
  return createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
}
