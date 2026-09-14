import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '@geo/db';
import { accountProfiles } from '@geo/db';

export interface AcquiredProfile {
  id: number;
  profileKey: string;
  fingerprint: Record<string, unknown>;
  proxyHint: string | null;
  contextRef: string | null;
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
    // drizzle 暴露底层 pool;直接用事务级 SELECT FOR UPDATE SKIP LOCKED
    const res = await client.query<{
      id: number;
      fingerprint: Record<string, unknown>;
      proxy_hint: string | null;
      context_ref: string | null;
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
       returning ap.id, ap.fingerprint, ap.proxy_hint, ap.context_ref`,
      [engine, excludeIds.size > 0 ? [...excludeIds] : [-1]],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      profileKey: `profile:${row.id}`,
      fingerprint: row.fingerprint,
      proxyHint: row.proxy_hint,
      contextRef: row.context_ref,
    };
  }

  /** 登录态失效(docs/04 §3.1 生命周期):不扣健康分,摘出可用池等人工重登。 */
  async markLoginRequired(profileId: number): Promise<void> {
    await this.db
      .update(accountProfiles)
      .set({ status: 'login_required' })
      .where(eq(accountProfiles.id, profileId));
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
}
