import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadPlatformSettings, personaImportJobs, personaLibrary } from '@geo/db';
import { InsightAgent } from '@geo/insight-agent';
import { personaHubUseAllowed } from '@geo/shared';
import { DB } from '../common/infra.module';
export const PERSONA_HUB_REVISION = '72bf19b886312041b32f7cae12c02dab8653c6fa';
export const PERSONA_HUB_URL = `https://raw.githubusercontent.com/tencent-ailab/persona-hub/${PERSONA_HUB_REVISION}/data/persona.jsonl`;
export function personaHubAllowed() { return personaHubUseAllowed(process.env); }
@Injectable()
export class PersonaLibraryService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}
  async list(query?: string, offset = 0, status?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpException('分页参数不正确', 400);
    const filter = query?.trim().slice(0, 100);
    if (status && !['imported', 'queued', 'enriching', 'ready', 'failed'].includes(status)) throw new HttpException('不支持的筛选状态', 400);
    const rows = await this.db.select({ id: personaLibrary.id, description: personaLibrary.description, profile: personaLibrary.profile, status: personaLibrary.status, sourceUrl: personaLibrary.sourceUrl, sourceRevision: personaLibrary.sourceRevision, license: personaLibrary.license, parserVersion: personaLibrary.parserVersion, lastError: personaLibrary.lastError }).from(personaLibrary)
      .where(and(
        status ? eq(personaLibrary.status, status) : undefined,
        filter ? ilike(personaLibrary.description, `%${filter.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
      )).orderBy(desc(personaLibrary.id)).limit(30).offset(offset);
    const counts = (await this.db.select({ total: sql<number>`count(*)::int`, ready: sql<number>`count(*) filter (where status = 'ready')::int`, pending: sql<number>`count(*) filter (where status in ('queued','enriching'))::int`, failed: sql<number>`count(*) filter (where status = 'failed')::int`, imported: sql<number>`count(*) filter (where status = 'imported')::int` }).from(personaLibrary))[0];
    const jobs = await this.db.select({ id: personaImportJobs.id, status: personaImportJobs.status, requestedCount: personaImportJobs.requestedCount, processed: personaImportJobs.processed, imported: personaImportJobs.imported, lastError: personaImportJobs.lastError }).from(personaImportJobs).orderBy(desc(personaImportJobs.id)).limit(5);
    return { rows, counts, jobs, offset, hasMore: rows.length === 30, allowed: personaHubAllowed(), license: 'CC-BY-NC-SA-4.0', sourceUrl: PERSONA_HUB_URL, sourceRevision: PERSONA_HUB_REVISION };
  }
  async startImport(accountId: number, count: number) {
    if (!personaHubAllowed()) throw new HttpException('Persona Hub 数据仅允许非商业使用；生产接入需配置已取得的商业授权记录', 409);
    if (!Number.isSafeInteger(count) || count < 1 || count > 200000) throw new HttpException('导入数量需为 1–200000 的整数', 400);
    const [row] = await this.db.insert(personaImportJobs).values({ requestedBy: accountId, requestedCount: count, sourceUrl: PERSONA_HUB_URL, sourceRevision: PERSONA_HUB_REVISION, license: 'CC-BY-NC-SA-4.0' }).onConflictDoNothing().returning();
    if (!row) throw new HttpException('已有导入任务正在运行，请等待完成', 409);
    return { id: row.id, status: row.status };
  }
  async enrich(limit: number) {
    if (!personaHubAllowed()) throw new HttpException('当前环境未启用 Persona Hub 授权', 409);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpException('每批增强 1–500 条', 400);
    if (!new InsightAgent({ settings: (await loadPlatformSettings(this.db)).insightAgent }).usable) throw new HttpException('请先配置可用的真实模型', 503);
    const result = await this.db.execute(sql`with picked as (select id from persona_library where status in ('imported','failed') order by id limit ${limit} for update skip locked)
      update persona_library p set status='queued', last_error=null, task_token=null, heartbeat_at=null, updated_at=now() from picked where p.id=picked.id returning p.id`);
    return { queued: result.rows.length };
  }

  /** 全库增强(全量转化):把所有未增强的源描述批量入队,worker 并发消化;量大时以天计。 */
  async enrichAll() {
    if (!personaHubAllowed()) throw new HttpException('当前环境未启用 Persona Hub 授权', 409);
    if (!new InsightAgent({ settings: (await loadPlatformSettings(this.db)).insightAgent }).usable) throw new HttpException('请先配置可用的真实模型', 503);
    const result = await this.db.execute(sql`update persona_library p set status='queued', last_error=null, task_token=null, heartbeat_at=null, updated_at=now()
      where p.status in ('imported','failed') returning p.id`);
    return { queued: result.rows.length };
  }
}
