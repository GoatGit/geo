import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '@geo/db';
import { accountProfiles } from '@geo/db';
import { WEB_ENGINES, type BrowserStorageState } from '@geo/shared';

export interface AcquiredProfile {
  id: number;
  profileKey: string;
  fingerprint: Record<string, unknown>;
  proxyHint: string | null;
  /** 出口租约绑定(IP 亲和):档案上次成功登录/采集所用的代理 server,采集时按此复用同一出口 */
  proxyServer: string | null;
  contextRef: string | null;
  /** 登录成功导出的 Cookie(采集会话注入,登录态留存不依赖平台 Context 能力) */
  cookies: Array<Record<string, unknown>> | null;
  storageState: BrowserStorageState | null;
}

/** 单账号单日提问上限(docs/04 §3.2 配额内化,超限强制轮换)。 */
export const DAILY_QUOTA_PER_PROFILE = 20;

/**
 * 健康分结果状态迁移(docs/04 §3.2,M0 取值,PoC 后按封损率校准):
 * ≤30 退役;<60 冷却 24h;其余保持可用。纯函数便于单测。
 */
export function nextHealthAction(score: number): 'retire' | 'cooldown' | 'keep' {
  if (score <= 30) return 'retire';
  if (score < 60) return 'cooldown';
  return 'keep';
}

/**
 * 账号池服务(docs/04 §3):健康分模型 + 会话粘性 + 配额内化。
 * 领取用 FOR UPDATE SKIP LOCKED,多 Worker 并发下不撞号;
 * excludeIds 供失败重试换号(docs/04 §5:重试必须更换账号)。
 * 健康分:连续成功 +1(封顶 100),失败 −2。
 */
export class AccountPoolService {
  constructor(private readonly db: Db) {}

  async acquire(engine: string, excludeIds: ReadonlySet<number> = new Set()): Promise<AcquiredProfile | null> {
    const client = this.db.$client as Pool;
    // 冷却到期自愈:瞬时登录误判(10min)与健康分 24h 冷却都把 status 置为 'cooldown',
    // 而领取条件要求 status='available'——没有这条回收,冷却档案永远无法自动回池
    // (只能人工逐个 recover),账号池随失败单调缩水直至全量 quota_blocked
    await client.query(
      `update account_profiles
       set status = 'available', cooldown_until = null
       where engine = $1 and surface = 'web' and status = 'cooldown'
         and cooldown_until is not null and cooldown_until < now()`,
      [engine],
    );
    // drizzle 暴露底层 pool;直接用事务级 SELECT FOR UPDATE SKIP LOCKED
    const res = await client.query<{
      id: number;
      fingerprint: Record<string, unknown>;
      proxy_hint: string | null;
      proxy_server: string | null;
      context_ref: string | null;
      cookies: Array<Record<string, unknown>> | null;
      storage_state: BrowserStorageState | null;
    }>(
      `with picked as (
         select id from account_profiles
         where engine = $1 and surface = 'web' and status = 'available'
           and (cooldown_until is null or cooldown_until < now())
           and (daily_date is distinct from current_date or daily_used < ${DAILY_QUOTA_PER_PROFILE})
           and not (id = any($2::bigint[]))
         order by health_score desc, daily_used asc
         limit 1
         for update skip locked
       )
       update account_profiles ap
       set daily_used = case when ap.daily_date is distinct from current_date then 1 else ap.daily_used + 1 end,
           daily_date = current_date
       from picked
       where ap.id = picked.id
       returning ap.id, ap.fingerprint, ap.proxy_hint, ap.proxy_server, ap.context_ref, ap.cookies, ap.storage_state`,
      [engine, excludeIds.size > 0 ? [...excludeIds] : [-1]],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      profileKey: `profile:${row.id}`,
      fingerprint: row.fingerprint,
      proxyHint: row.proxy_hint,
      proxyServer: row.proxy_server,
      contextRef: row.context_ref,
      cookies: row.cookies,
      storageState: row.storage_state,
    };
  }

  /** 绑定档案与出口租约(IP 亲和):登录成功/采集成功后调用,后续采集复用同一出口。 */
  async bindProxy(profileId: number, server: string): Promise<void> {
    await this.db
      .update(accountProfiles)
      .set({ proxyServer: server })
      .where(eq(accountProfiles.id, profileId));
  }

  /** A collection result must not invalidate credentials from a newer manual login. */
  private loginVersion(profile: AcquiredProfile) {
    return and(
      eq(accountProfiles.id, profile.id),
      inArray(accountProfiles.status, ['available', 'cooldown']),
      sql`${accountProfiles.storageState} is not distinct from ${profile.storageState === null ? null : JSON.stringify(profile.storageState)}::jsonb`,
      sql`${accountProfiles.cookies} is not distinct from ${profile.cookies === null ? null : JSON.stringify(profile.cookies)}::jsonb`,
    );
  }

  /** Save rotating tokens/device state without overwriting a concurrent re-login. */
  async saveStorageState(profile: AcquiredProfile, storageState: BrowserStorageState): Promise<void> {
    await (this.db.$client as Pool).query(
      `update account_profiles set storage_state = $1::jsonb, cookies = $2::jsonb
       where id = $3 and status = 'available'
         and storage_state is not distinct from $4::jsonb
         and cookies is not distinct from $5::jsonb`,
      [JSON.stringify(storageState), JSON.stringify(storageState.cookies), profile.id,
        profile.storageState === null ? null : JSON.stringify(profile.storageState),
        profile.cookies === null ? null : JSON.stringify(profile.cookies)],
    );
  }

  /** 有持久化 Cookie 但被引擎判未登录(多为出口 IP 变化):短冷却自动重试,不要求人工重登。 */
  async markTransientLoginMiss(profile: AcquiredProfile, minutes = 10): Promise<void> {
    await this.db
      .update(accountProfiles)
      .set({ status: 'cooldown', cooldownUntil: new Date(Date.now() + minutes * 60 * 1000) })
      .where(this.loginVersion(profile));
  }

  /** 登录态失效(docs/04 §3.1 生命周期):不扣健康分,摘出可用池等人工重登。 */
  async markLoginRequired(profile: AcquiredProfile): Promise<void> {
    await this.db
      .update(accountProfiles)
      // A redirect or temporary challenge is not proof that stored credentials are dead.
      .set({ status: 'login_required', cooldownUntil: null })
      .where(this.loginVersion(profile));
  }

  async report(engine: string, profileId: number, ok: boolean): Promise<void> {
    void engine;
    const delta = ok ? 1 : -2;
    // RETURNING 一步拿到新分,避免读-改-写竞态(并发失败同一档案时误判迁移)
    const res = await (this.db.$client as Pool).query<{ health_score: number }>(
      `update account_profiles
       set health_score = least(100, greatest(0, health_score + $1))
       where id = $2
       returning health_score`,
      [delta, profileId],
    );
    const score = res.rows[0]?.health_score;
    if (score === undefined || ok) return;

    const action = nextHealthAction(score);
    if (action === 'retire') {
      await this.db
        .update(accountProfiles)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(eq(accountProfiles.id, profileId));
    } else if (action === 'cooldown') {
      await this.db
        .update(accountProfiles)
        .set({ status: 'cooldown', cooldownUntil: new Date(Date.now() + 24 * 3600 * 1000) })
        .where(eq(accountProfiles.id, profileId));
    }
  }

  /**
   * 确保每个引擎至少有 perEngine 个可用档案,不足则补种(mock 虚拟档案)。
   * 仅 mock 采集模式下调用:真实浏览器模式的档案含真实登录态,必须人工录入(docs/04 §3.1),
   * 否则账号池为空会导致全部任务无限延迟重排、采集静默空转。
   */
  async ensureMockProfiles(perEngine = 2): Promise<void> {
    for (const engine of WEB_ENGINES) {
      const res = await (this.db.$client as Pool).query<{ count: string }>(
        `select count(*) as count from account_profiles
         where engine = $1 and surface = 'web' and status = 'available'`,
        [engine],
      );
      const have = Number(res.rows[0]?.count ?? 0);
      for (let i = have; i < perEngine; i++) {
        await this.db.insert(accountProfiles).values({
          engine,
          surface: 'web',
          fingerprint: {
            ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            viewport: '1366x768',
            locale: 'zh-CN',
          },
          proxyHint: `residential:mock:${engine}:${i}`,
          contextRef: `mock-context-${engine}-${i}`,
          healthScore: 100,
          status: 'available',
        });
      }
    }
  }
}
