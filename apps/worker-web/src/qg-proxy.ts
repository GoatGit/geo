/**
 * 青果网络长效代理池(docs/07 §13 闸门 #2 落地):
 * - AgentBay BrowserOption.proxy 实测被静默忽略;改用 Playwright context 级代理
 *   (connectOverCDP 后 newContext({proxy})),沙箱内浏览器流量经代理出口。
 * - 长效静态 IP + 通道制:粘性共享——全部引擎档案共用一个稳定出口 IP,
 *   登录 Cookie 与出口 IP 绑定一致,根治"登录后需重登"(引擎拒绝跨 IP 会话)。
 * - 白名单:代理按客户端 IP 鉴权;沙箱出口 IP 自动发现并幂等加白。
 * 接口:longterm.proxy.qg.net(get/channels/delete) + proxy.qg.net/whitelist/*。
 */
const LONGTERM = 'https://longterm.proxy.qg.net';
const WHITELIST_API = 'https://proxy.qg.net/whitelist';

export interface QgProxyLease {
  server: string;
  egressIp: string;
  area?: string;
  isp?: string;
  deadline?: string;
}

interface QgGetResponse {
  code: string;
  data?: {
    task_id?: string;
    ips?: Array<{ proxy_ip: string; server: string; area?: string; isp?: string; deadline?: string }>;
  };
  message?: string;
}

async function qgGet(url: string): Promise<{ ok: boolean; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return { ok: res.ok, body: (await res.text()).trim() };
}

export class QgProxyPool {
  private lease: QgProxyLease | null = null;
  private whitelistedEgress: string | null = null;
  private lastChannelWarn = 0;

  constructor(private key: string) {}

  get enabled(): boolean {
    return Boolean(this.key);
  }

  /** 管理后台改 Key 后热切换:清空租约,后续 acquire 用新 Key 提取。 */
  rekey(key: string): void {
    const next = key ?? '';
    if (next === this.key) return;
    this.key = next;
    this.lease = null;
    this.whitelistedEgress = null;
    console.log(`[proxy-pool] Key 已更新(管理后台),租约重置`);
  }

  /** 当前租约(内存缓存;进程重启后重新提取同一静态 IP 或新 IP 均可接受)。 */
  current(): QgProxyLease | null {
    return this.lease;
  }

  /** 取代理(无则提取);通道不足时返回 null 由调用方直连降级。 */
  async acquire(): Promise<QgProxyLease | null> {
    if (!this.enabled) return null;
    if (this.lease) return this.lease;
    const r = await qgGet(`${LONGTERM}/get?key=${this.key}&num=1&format=json`);
    try {
      const j = JSON.parse(r.body) as QgGetResponse;
      const ip = j.data?.ips?.[0];
      if (j.code === 'SUCCESS' && ip?.server) {
        this.lease = {
          server: ip.server,
          egressIp: ip.proxy_ip,
          area: ip.area,
          isp: ip.isp,
          deadline: ip.deadline,
        };
        console.log(`[proxy-pool] 青果代理租约 ${ip.server}(出口 ${ip.proxy_ip},${ip.area ?? ''}${ip.isp ?? ''},到期 ${ip.deadline ?? '?'})`);
        return this.lease;
      }
      // 通道被占(如进程重启前已提取):从在用列表认领既有租约
      if (j.code === 'NO_AVAILABLE_CHANNEL') {
        const adopted = await this.adoptFromInUse();
        if (adopted) return adopted;
      }
      if (Date.now() - this.lastChannelWarn > 10 * 60_000) {
        console.warn(`[proxy-pool] 提取失败(${j.code}:${j.message ?? r.body.slice(0, 80)}),本轮直连降级`);
        this.lastChannelWarn = Date.now();
      }
      return null;
    } catch {
      console.warn(`[proxy-pool] 提取响应异常:${r.body.slice(0, 80)},直连降级`);
      return null;
    }
  }

  /** 从"查询在用IP"(/query)认领租约:通道被既有提取占用时复用(静态 IP 长效)。 */
  private async adoptFromInUse(): Promise<QgProxyLease | null> {
    const r = await qgGet(`${LONGTERM}/query?key=${this.key}&format=json`);
    try {
      type QgLease = { proxy_ip: string; server: string; area?: string; isp?: string; deadline?: string };
      const j = JSON.parse(r.body) as {
        code: string;
        // 实测两种形态:data 直接为租约数组,或 {tasks: {...}} 包一层
        data?: QgLease[] | { tasks?: Record<string, { ips?: QgLease[] }> | Array<{ ips?: QgLease[] }> };
      };
      const ips: QgLease[] = Array.isArray(j.data)
        ? j.data
        : Object.values((j.data as { tasks?: object } | undefined)?.tasks ?? {}).flatMap((t) =>
            Array.isArray(t)
              ? ((t as Array<{ ips?: QgLease[] }>)[0]?.ips ?? [])
              : ((t as { ips?: QgLease[] }).ips ?? []),
          );
      const live = ips.find((ip) => {
        if (!ip.server) return false;
        // 过期租约不认领(deadline 为本地时间近似比较)
        if (ip.deadline) {
          const dl = new Date(ip.deadline.replace(' ', 'T') + '+08:00').getTime();
          if (Number.isFinite(dl) && dl < Date.now() + 10 * 60_000) return false;
        }
        return true;
      });
      if (j.code === 'SUCCESS' && live) {
        this.lease = {
          server: live.server,
          egressIp: live.proxy_ip,
          area: live.area,
          isp: live.isp,
          deadline: live.deadline,
        };
        console.log(`[proxy-pool] 认领在用租约 ${live.server}(出口 ${live.proxy_ip},到期 ${live.deadline ?? '?'})`);
        return this.lease;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 通道与白名单自检(启动时调用一次,结果只打日志)。 */
  async bootstrap(): Promise<void> {
    if (!this.enabled) return;
    const ch = await qgGet(`${LONGTERM}/channels?key=${this.key}&format=json`);
    console.log(`[proxy-pool] 通道状态:${ch.body.slice(0, 80)}`);
    await this.acquire(); // 提取;通道被占则自动认领在用租约
  }

  /** 由外部(真实会话内)上报沙箱出口 IP 并确保在白名单里(代理按客户端 IP 鉴权)。 */
  async ensureWhitelisted(egressIp: string): Promise<void> {
    if (!this.enabled || !egressIp || egressIp === this.whitelistedEgress) return;
    const q = await qgGet(`${WHITELIST_API}/query?Key=${this.key}&format=json`);
    if (q.body.includes(egressIp)) {
      this.whitelistedEgress = egressIp;
      return;
    }
    const a = await qgGet(`${WHITELIST_API}/add?Key=${this.key}&IP=${egressIp}`);
    if (a.body.includes('"Num":1') || a.body.includes(egressIp)) {
      this.whitelistedEgress = egressIp;
      console.log(`[proxy-pool] 沙箱出口 ${egressIp} 已加白`);
    } else {
      console.warn(`[proxy-pool] 白名单添加失败:${a.body.slice(0, 80)}`);
    }
  }

  /** 代理失效(连接拒绝/过期)时清空租约,下次 acquire 重提。 */
  invalidate(): void {
    if (this.lease) {
      console.warn(`[proxy-pool] 租约 ${this.lease.server} 失效,清空待重提`);
      this.lease = null;
    }
  }
}

/** 从环境构建(QG_PROXY_KEY 为空则禁用,直连模式不变)。 */
export function createProxyPoolFromEnv(env: NodeJS.ProcessEnv = process.env): QgProxyPool {
  return new QgProxyPool(env.QG_PROXY_KEY ?? '');
}

/**
 * 管理后台可配置的代理池(平台旋钮 docs/03 §3.2):
 * 配置存 platform_settings.proxyPool(60s 热加载),env QG_PROXY_KEY 为兜底默认。
 * processor / login-manager 统一经本管理器取代理。
 */
export class ProxyPoolManager {
  private pool: QgProxyPool;
  private timer?: NodeJS.Timeout;
  private readonly db: { select: unknown };

  constructor(db: unknown, fallbackKey: string) {
    this.db = db as { select: unknown };
    this.pool = new QgProxyPool(fallbackKey);
  }

  start(intervalMs = 60_000): void {
    void this.reload();
    this.timer = setInterval(() => void this.reload(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reload(): Promise<void> {
    try {
      const { loadPlatformSettings } = await import('@geo/db');
      const settings = await loadPlatformSettings(this.db as never);
      const key = settings.proxyPool.enabled && settings.proxyPool.key
        ? settings.proxyPool.key
        : '';
      this.pool.rekey(key);
    } catch {
      // 配置读取失败:保持现状(env 兜底)
    }
  }

  async acquire(): Promise<QgProxyLease | null> {
    return this.pool.acquire();
  }

  current(): QgProxyLease | null {
    return this.pool.current();
  }

  async bootstrap(): Promise<void> {
    await this.pool.bootstrap();
  }
}
