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
  /** 存活租约表(key = server,即 ip:port):多通道并存,档案按绑定亲和取用。 */
  private leases = new Map<string, QgProxyLease>();
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
    this.leases.clear();
    this.whitelistedEgress = null;
    console.log(`[proxy-pool] Key 已更新(管理后台),租约重置`);
  }

  /** 当前任一存活租约(兼容旧调用方;进程重启后经 adopt 认领同一静态 IP)。 */
  current(): QgProxyLease | null {
    return this.liveLeases()[0] ?? null;
  }

  /** deadline 非空的以本地时间近似判定,余量 10 分钟;无 deadline 视为存活。 */
  private isLive(l: QgProxyLease): boolean {
    if (!l.deadline) return true;
    const dl = new Date(l.deadline.replace(' ', 'T') + '+08:00').getTime();
    return !(Number.isFinite(dl) && dl < Date.now() + 10 * 60_000);
  }

  private liveLeases(): QgProxyLease[] {
    return [...this.leases.values()].filter((l) => this.isLive(l));
  }

  /**
   * 按档案取租约(IP 亲和,采集事故复盘):同一档案的登录与采集必须同一出口 IP——
   * 引擎风控把 Cookie 绑定到登录时的出口,跨 IP 会话被判 needs_login。
   * bindingServer = 档案上次的租约 server(account_profiles.proxy_server):
   * - 命中且存活 → 原样返回(rotated=false);
   * - 有绑定但该租约已消失/到期 → 分配现有或新租约并标 rotated=true,调用方必须按
   *   "出口已切换"语义处理(重绑 + 短冷却,不得计入 2-strike 清 Cookie);
   * - 无绑定(首次)→ 优先复用存活租约(粘性共享,不占新通道),没有才提取。
   */
  async acquireForProfile(bindingServer: string | null): Promise<{ lease: QgProxyLease | null; rotated: boolean }> {
    if (!this.enabled) return { lease: null, rotated: false };
    if (this.liveLeases().length === 0) await this.adoptAllFromInUse();
    let live = this.liveLeases();

    if (bindingServer) {
      const bound = this.leases.get(bindingServer);
      if (bound && this.isLive(bound)) return { lease: bound, rotated: false };
      // 绑定的租约可能刚续期:再同步一次在用列表后仍无,才判定切换
      if (!live.some((l) => l.server === bindingServer)) await this.adoptAllFromInUse();
      live = this.liveLeases();
      const rebound = bindingServer ? this.leases.get(bindingServer) : undefined;
      if (rebound && this.isLive(rebound)) return { lease: rebound, rotated: false };
      const lease = live[0] ?? (await this.extractNew());
      if (!lease) return { lease: null, rotated: false };
      return { lease, rotated: lease.server !== bindingServer };
    }

    const lease = live[0] ?? (await this.extractNew());
    return { lease: lease ?? null, rotated: false };
  }

  /** 兼容旧调用方:取任一存活租约(无则提取)。 */
  async acquire(): Promise<QgProxyLease | null> {
    const { lease } = await this.acquireForProfile(null);
    return lease;
  }

  /** 提取新通道(/get);NO_AVAILABLE_CHANNEL 时自动认领在用租约。 */
  private async extractNew(): Promise<QgProxyLease | null> {
    const adopted = await this.adoptAllFromInUse();
    if (adopted > 0) return this.liveLeases()[0] ?? null;
    const r = await qgGet(`${LONGTERM}/get?key=${this.key}&num=1&format=json`);
    try {
      const j = JSON.parse(r.body) as QgGetResponse;
      const ip = j.data?.ips?.[0];
      if (j.code === 'SUCCESS' && ip?.server) {
        const lease = {
          server: ip.server,
          egressIp: ip.proxy_ip,
          area: ip.area,
          isp: ip.isp,
          deadline: ip.deadline,
        };
        this.leases.set(lease.server, lease);
        console.log(`[proxy-pool] 青果代理租约 ${lease.server}(出口 ${lease.egressIp},${lease.area ?? ''}${lease.isp ?? ''},到期 ${lease.deadline ?? '?'})`);
        return lease;
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

  /** 解析 /query 的两种实测形态:data 直接为租约数组,或 {tasks:{...}} 包一层。 */
  private parseInUse(body: string): Array<{ proxy_ip: string; server: string; area?: string; isp?: string; deadline?: string }> {
    try {
      type QgLease = { proxy_ip: string; server: string; area?: string; isp?: string; deadline?: string };
      const j = JSON.parse(body) as {
        code: string;
        data?: QgLease[] | { tasks?: Record<string, { ips?: QgLease[] }> | Array<{ ips?: QgLease[] }> };
      };
      const raw = j.data;
      const ips: QgLease[] = Array.isArray(raw)
        ? raw
        : Object.values((raw as { tasks?: object } | undefined)?.tasks ?? {}).flatMap((t) =>
            Array.isArray(t)
              ? ((t as Array<{ ips?: QgLease[] }>)[0]?.ips ?? [])
              : ((t as { ips?: QgLease[] }).ips ?? []),
          );
      return ips.filter((ip): ip is QgLease => Boolean(ip && ip.server && ip.proxy_ip));
    } catch {
      return [];
    }
  }

  /** 同步在用租约到 map(幂等):返回本次新认领的数量。 */
  private async adoptAllFromInUse(): Promise<number> {
    const r = await qgGet(`${LONGTERM}/query?key=${this.key}&format=json`);
    const ips = this.parseInUse(r.body);
    let adopted = 0;
    for (const ip of ips) {
      if (this.leases.has(ip.server)) continue;
      const lease = {
        server: ip.server,
        egressIp: ip.proxy_ip,
        area: ip.area,
        isp: ip.isp,
        deadline: ip.deadline,
      };
      if (!this.isLive(lease)) continue; // 过期租约不认领
      this.leases.set(lease.server, lease);
      adopted += 1;
      console.log(`[proxy-pool] 认领在用租约 ${lease.server}(出口 ${lease.egressIp},到期 ${lease.deadline ?? '?'})`);
    }
    return adopted;
  }

  /** 通道与白名单自检(启动时调用一次,结果只打日志)。 */
  async bootstrap(): Promise<void> {
    if (!this.enabled) return;
    // 自检失败不得阻断启动(代理 API 抖动/超时曾致 worker CrashLoopBackOff):
    // 降级直连,后续 acquire 每次任务都会重试提取
    try {
      const ch = await qgGet(`${LONGTERM}/channels?key=${this.key}&format=json`);
      console.log(`[proxy-pool] 通道状态:${ch.body.slice(0, 80)}`);
      await this.acquire(); // 提取;通道被占则自动认领在用租约
    } catch (err) {
      console.warn(`[proxy-pool] bootstrap 自检失败,降级直连(下次任务重试提取):${(err as Error).message}`);
      this.leases.clear();
    }
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
    if (this.leases.size > 0) {
      console.warn(`[proxy-pool] 租约失效,清空 ${this.leases.size} 条待重提`);
      this.leases.clear();
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

  /** 按档案取租约(IP 亲和):binding = account_profiles.proxy_server。 */
  async acquireForProfile(
    bindingServer: string | null,
  ): Promise<{ lease: QgProxyLease | null; rotated: boolean }> {
    return this.pool.acquireForProfile(bindingServer);
  }

  current(): QgProxyLease | null {
    return this.pool.current();
  }

  async bootstrap(): Promise<void> {
    await this.pool.bootstrap();
  }
}
