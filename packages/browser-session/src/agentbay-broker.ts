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

/**
 * 应用侧会话最长存活兜底(env 可覆盖):登录要覆盖人工扫码窗口,采集要覆盖整条 ask 硬墙。
 * login 25min = LOGIN_TIMEOUT_MS 默认 10min + 导航/复核/释放余量;
 * collect 9min = ASK_TIMEOUT_MS 120s + ASK_HARD_MARGIN_MS 120s + 余量。
 */
const DEFAULT_SESSION_MAX_AGE_MS = { login: 25 * 60_000, collect: 9 * 60_000 } as const;

/** 会话标签的应用标识:ListSession 可按键值过滤,用于失败后精确找回本次创建的无主会话。 */
const SESSION_LABEL_APP = 'geolens';

/** 云端已回收/会话不存在的错误码:视为释放完成,不再保留登记重试。 */
function isGoneSessionError(message: string): boolean {
  return /not.?found|not.?exist|invalid.?session|expired|不存在|已过期/i.test(message);
}

export class AgentBaySessionBroker implements SessionBroker {
  private readonly config: AgentBayConfig;
  /** 本进程持有、尚未确认释放的会话(release 幂等 + 优雅退出兜底)。 */
  private readonly live = new Map<string, () => Promise<void>>();
  /**
   * 会话登记钩子(调用方亦可绕过 SessionRegistry 自行记账):
   * 登录用途会话带 ManualRelease,worker 崩溃(OOM/发版 kill)时 finally 不会执行。
   */
  onAcquired?: (sessionId: string, purpose: string) => void;
  onReleased?: (sessionId: string) => void;

  constructor(config: AgentBayConfig) {
    if (!config.apiKey) throw new BrokerError('AGENTBAY_API_TOKEN is required');
    this.config = config;
  }

  /**
   * 强制回收指定会话(孤儿扫除器用):带 3 次退避重试,失败仅记日志。
   * 云端已回收/会话不存在一律视为成功(否则登记会永远删不掉)。
   */
  async forceRelease(sessionId: string): Promise<boolean> {
    for (let i = 1; i <= 3; i++) {
      try {
        await this.releaseById(sessionId);
        await this.afterRelease(sessionId);
        return true;
      } catch (err) {
        console.error(`[agentbay] forceRelease ${sessionId} 第 ${i} 次失败:`, (err as Error).message);
        await new Promise((r) => setTimeout(r, 5_000 * i));
      }
    }
    return false;
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
    // 每次 acquire 带唯一 attempt 标签:云端存在「会话其实建出来了,但响应超时」的情形(实测
    // CreateMcpSession 返回 DEFAULT_SYS_ERROR/sendCommandMessage failed: timeout 且无 SessionId)。
    // 那种情况下调用方既拿不到 ID 去 release、也无从登记,只能靠标签反查回收(见 reclaimLostCreate)。
    const attempt = randomUUID();
    let createRes: Record<string, unknown>;
    try {
      createRes = await this.rpc('CreateMcpSession', {
        ...body,
        ImageId: this.config.imageId,
        RegionId: regionId,
        // 登录会话声明手动释放:防止云端按默认时长自动回收,扫码中途窗口消失(释放仍由 finally 兜底)
        ...(profile.purpose === 'login' ? { ManualRelease: 'true' } : {}),
        Labels: JSON.stringify({ app: SESSION_LABEL_APP, attempt }),
      });
    } catch (err) {
      // 建的可能是「失败」也可能是「建成了但响应丢了」:按标签核对并回收,再把原错误抛给调用方
      await this.reclaimLostCreate(attempt);
      throw err;
    }
    const sessionId = strField(createRes, ['SessionId', 'sessionId']);
    if (!sessionId) {
      await this.reclaimLostCreate(attempt);
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

      // 释放幂等:finally、TTL 兜底、destroyAll 可能重复调用,只发一次 RPC。
      // 释放失败不阻塞主流程,但必须保留登记 —— 否则 ManualRelease 会话会永久计费。
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        try {
          await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId });
          await this.afterRelease(sessionId);
        } catch (err) {
          const message = (err as Error).message;
          if (isGoneSessionError(message)) {
            // 云端已回收:等同于释放成功
            await this.afterRelease(sessionId);
          } else {
            console.error(`[agentbay] 释放会话失败 session=${sessionId}(登记保留,待清扫重试):`, message);
          }
        } finally {
          this.live.delete(sessionId);
        }
      };
      // 兜底:调用方卡死/漏调 release 时到点强制释放,避免 ManualRelease 会话按小时空烧
      const timer = setTimeout(() => void release(), this.maxAgeOf(profile.purpose ?? 'collect'));
      timer.unref?.();
      this.live.set(sessionId, release);

      // 先登记再交付:进程崩溃时 finally 不执行,登记是下次启动找回孤儿的唯一线索
      await this.trackSession(sessionId, Date.now(), profile.purpose ?? 'collect');
      this.onAcquired?.(sessionId, profile.purpose ?? 'collect');
      return {
        sessionId,
        cdpUrl,
        imageId: this.config.imageId,
        contextId,
        release,
      };
    } catch (err) {
      await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId }).catch(() => undefined);
      throw err;
    }
  }

  /** 无 handle 时按 ID 释放(启动清扫遗留会话)。会话已不存在视为成功。 */
  async releaseById(sessionId: string): Promise<void> {
    try {
      await this.rpc('ReleaseMcpSession', {
        Authorization: `Bearer ${this.config.apiKey}`,
        SessionId: sessionId,
      });
    } catch (err) {
      if (isGoneSessionError((err as Error).message)) return;
      throw err;
    }
  }

  /**
   * 创建调用失败后的补偿:云端可能已经建出会话但响应超时丢失,
   * 调用方既拿不到 SessionId 去释放、也无法登记 —— 不回收就是一只按小时计费的无主会话。
   *
   * 用每次 acquire 独有的 `attempt` 标签反查(实测 ListSession 支持 Labels 过滤),
   * 而不是「与创建前快照做差集」:差集会误杀同一时刻其他实例刚建出的正常会话。
   * 反查/释放本身失败时只告警,不能掩盖创建失败的原错误。
   */
  private async reclaimLostCreate(attempt: string): Promise<number> {
    let sessionIds: string[];
    try {
      const listRes = await this.rpc('ListSession', {
        Authorization: `Bearer ${this.config.apiKey}`,
        MaxResults: '50',
        Labels: JSON.stringify({ app: SESSION_LABEL_APP, attempt }),
      });
      sessionIds = sessionIdsFrom(listRes);
    } catch (err) {
      console.error(
        `[agentbay] 创建失败后无法反查会话(可能残留无主会话,需人工核对) attempt=${attempt}:`,
        (err as Error).message,
      );
      return 0;
    }
    let released = 0;
    for (const id of sessionIds) {
      try {
        await this.releaseById(id);
        released++;
        console.warn(`[agentbay] 创建响应超时但云端已建出会话,已回收 session=${id} attempt=${attempt}`);
      } catch (err) {
        console.error(`[agentbay] 无主会话回收失败 session=${id}(需人工释放):`, (err as Error).message);
      }
    }
    return released;
  }

  /**
   * 清扫遗留会话:只释放登记时间已超过该用途上限的会话。
   * 多实例部署下新实例启动时会看到其他实例正在用的登记,按年龄过滤才不会互相误杀。
   */
  async sweepStaleSessions(): Promise<number> {
    const registry = this.config.sessionRegistry;
    if (!registry) return 0;
    // 取较短上限做候选阈值,再按各会话用途精确判定(否则采集孤儿会被登录上限拖到 25min)
    const candidateBefore = Date.now() -
      Math.min(this.maxAgeOf('login'), this.maxAgeOf('collect'));
    let released = 0;
    for (const entry of await registry.listOlderThan(candidateBefore)) {
      const purpose = entry.purpose ?? 'collect';
      if (Date.now() - entry.createdAt < this.maxAgeOf(purpose)) continue;
      try {
        await this.releaseById(entry.sessionId);
        await this.forgetSession(entry.sessionId);
        released++;
        console.warn(`[agentbay] 回收遗留会话 session=${entry.sessionId} purpose=${purpose} age=${Date.now() - entry.createdAt}ms`);
      } catch (err) {
        console.error(
          `[agentbay] 遗留会话释放失败 session=${entry.sessionId}(保留登记待下次重试):`,
          (err as Error).message,
        );
      }
    }
    return released;
  }

  /** 优雅退出:释放本进程仍持有的会话;失败保留登记,由下次启动清扫重试。 */
  async destroyAll(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map((release) => release()));
    this.live.clear();
  }

  private maxAgeOf(purpose: 'collect' | 'login'): number {
    const configured = this.config.sessionMaxAgeMs?.[purpose];
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_SESSION_MAX_AGE_MS[purpose];
  }

  /** 登记失败只降级为「失去崩溃后回收线索」,不阻断采集/登录(TTL 兜底仍在)。 */
  private async trackSession(sessionId: string, createdAt: number, purpose: 'collect' | 'login'): Promise<void> {
    const registry = this.config.sessionRegistry;
    if (!registry) return;
    try {
      await registry.track({ sessionId, createdAt, purpose });
    } catch (err) {
      console.warn(`[agentbay] 会话登记失败 session=${sessionId}:`, (err as Error).message);
    }
  }

  private async forgetSession(sessionId: string): Promise<void> {
    await this.config.sessionRegistry?.forget(sessionId).catch(() => undefined);
  }

  /** 释放确认后的统一收尾:注销登记(保留失败重试)+ 触发调用方钩子。 */
  private async afterRelease(sessionId: string): Promise<void> {
    await this.forgetSession(sessionId);
    this.onReleased?.(sessionId);
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

/**
 * ListSession 响应的 Data 是数组(JSON 形态),XML 形态则被压成扁平键值:
 * 统一取出其中的 SessionId 列表,找不到就返回空数组(宁可不释放,也不猜)。
 */
function sessionIdsFrom(res: unknown): string[] {
  const root = (res ?? {}) as Record<string, unknown>;
  const source: unknown[] = Array.isArray(res)
    ? res
    : Array.isArray(root.Data)
      ? (root.Data as unknown[])
      : [root.Data ?? root];
  const out: string[] = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const id = strField(item as Record<string, unknown>, ['SessionId', 'sessionId']);
    if (id) out.push(id);
  }
  return out;
}

/** profileKey('profile:5')→ 合法 Context 名。 */
function contextNameFor(profileKey: string): string {
  return `geo-${profileKey.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`;
}

/** 账号指纹哈希(日志/证据只落哈希,不落原文,docs/07 §10)。 */
export function fingerprintHash(profileKey: string): string {
  return createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
}
