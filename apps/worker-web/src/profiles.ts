import { and, eq, sql } from 'drizzle-orm';
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

/**
 * 账号池服务(docs/04 §3):健康分模型 + 会话粘性 + 配额内化。
 * 领取用 FOR UPDATE SKIP LOCKED,多 Worker 并发下不撞号。
 * 健康分(docs/04 §3.2):连续成功 +1(封顶 100),失败 −2;
 * ≤30 退役,<60 冷却 24h(M0 取值,PoC 后按封损率校准)。
 */
export class AccountPoolService {
  constructor(private readonly db: Db) {}

  async acquire(engine: string): Promise<AcquiredProfile | null> {
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
           and (daily_date is distinct from current_date or daily_used < 20)
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
      [engine],
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

  async report(engine: string, profileId: number, ok: boolean): Promise<void> {
    const delta = ok ? 1 : -2;
    await this.db.execute(sql`
      update account_profiles
      set health_score = least(100, greatest(0, health_score + ${delta}))
      where id = ${profileId}
    `);
    if (ok) return;

    const row = (
      await this.db.select().from(accountProfiles).where(eq(accountProfiles.id, profileId)).limit(1)
    )[0];
    if (!row) return;
    if (row.healthScore <= 30) {
      await this.db
        .update(accountProfiles)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(and(eq(accountProfiles.id, profileId)));
    } else if (row.healthScore < 60) {
      await this.db
        .update(accountProfiles)
        .set({ status: 'cooldown', cooldownUntil: new Date(Date.now() + 24 * 3600 * 1000) })
        .where(eq(accountProfiles.id, profileId));
    }
    void engine;
  }
}
