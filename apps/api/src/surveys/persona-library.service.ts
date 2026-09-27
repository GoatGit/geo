import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
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
    // 检索覆盖结构化字段(职业/性格/年龄段等)与原文,后者兜底未增强条目
    const like = filter ? `%${filter.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = await this.db.select({ id: personaLibrary.id, description: personaLibrary.description, profile: personaLibrary.profile, status: personaLibrary.status, sourceUrl: personaLibrary.sourceUrl, sourceRevision: personaLibrary.sourceRevision, license: personaLibrary.license, parserVersion: personaLibrary.parserVersion, lastError: personaLibrary.lastError }).from(personaLibrary)
      .where(and(
        status ? eq(personaLibrary.status, status) : undefined,
        like ? sql`(${personaLibrary.description} ilike ${like} or ${personaLibrary.profile}::text ilike ${like})` : undefined,
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

  /**
   * 人口地图(0019):按国内权威公开数据展示真实人口结构(国家统计局 2023 年公报),
   * 合成人群库的对应分布作为对照(仅同轴维度),帮助用户理解"目标人群在真实人口中的位置"。
   */
  async distribution() {
    const rows = (await this.db.execute(sql`
      select coalesce(nullif(profile->>'gender',''),'未知') as gender,
             coalesce(nullif(profile->>'ageBand',''),'未知') as age_band,
             coalesce(nullif(profile->>'cityTier',''),'未知') as city_tier,
             coalesce(nullif(profile->>'incomeBand',''),'未知') as income_band,
             coalesce(nullif(profile->>'occupationGroup',''),'未知') as occupation_group,
             count(*)::int as n
      from persona_library
      where status = 'ready'
      group by 1, 2, 3, 4, 5`)).rows as Array<Record<string, string | number>>;
    const normalize = (key: string, v: string): string => {
      const s = /^unknown$/i.test(v) ? '未知' : v;
      if (key === 'gender') return s.startsWith('女') ? '女' : s.startsWith('男') ? '男' : '未知';
      if (key === 'cityTier') return /一线/.test(s) && !/新一线/.test(s) ? '一线' : /新一线/.test(s) ? '新一线' : /二线/.test(s) ? '二线' : /三线/.test(s) ? '三线及以下' : '未知';
      return s;
    };
    const tally = (key: string) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const value = normalize(key, String(r[key]));
        m.set(value, (m.get(value) ?? 0) + Number(r.n));
      }
      // 已知取值降序在前,「未知」恒沉底——地图可读,且不掩饰档案边界
      return [...m.entries()].filter(([v]) => v !== '未知').map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
        .concat(([...m.entries()].filter(([v]) => v === '未知')).map(([value, count]) => ({ value, count })));
    };
    const pending = Number(((await this.db.execute(sql`select count(*)::int as n from persona_library where status in ('queued','enriching','imported')`)).rows[0] as { n: number }).n);
    const summary = (items: Array<{ value: string; count: number }>) =>
      items.slice(0, 3).map(x => `${x.value} ${x.count}`).join('、') || '暂无数据';
    return {
      pending,
      source: '国家统计局《2023年国民经济和社会发展统计公报》',
      /** 权威基准:数值与口径均出自公报原文;无官方口径的维度如实标注 */
      benchmark: {
        gender: {
          title: '性别构成', unit: '占总人口',
          rows: [
            { value: '男', share: 73211 / 140967, note: '73,211 万人' },
            { value: '女', share: 67756 / 140967, note: '67,756 万人' },
          ],
          syntheticNote: `合成人群库对照:${summary(tally('gender'))}`,
        },
        age: {
          title: '年龄结构', unit: '占总人口',
          rows: [
            { value: '0-15 岁', share: 0.176, note: '公报口径 0-14 岁 16.3%' },
            { value: '16-59 岁', share: 0.613 },
            { value: '60 岁及以上', share: 0.211, note: '其中 65 岁及以上 15.4%' },
          ],
          syntheticNote: `合成人群库对照(五档口径):${summary(tally('age_band'))}`,
        },
        region: {
          title: '城乡结构', unit: '常住人口',
          rows: [
            { value: '城镇', share: 0.662, note: '93,267 万人,城镇化率 66.2%' },
            { value: '乡村', share: 0.338, note: '47,700 万人' },
          ],
          syntheticNote: `合成人群库对照(城市层级,非官方划分):${summary(tally('city_tier'))}`,
        },
        income: {
          title: '居民收入(五等份)', unit: '各组占 20%',
          rows: [
            { value: '低收入组', share: 0.2, note: '人均可支配收入 9,215 元' },
            { value: '中间偏下组', share: 0.2, note: '20,442 元' },
            { value: '中间收入组', share: 0.2, note: '32,195 元' },
            { value: '中间偏上组', share: 0.2, note: '50,220 元' },
            { value: '高收入组', share: 0.2, note: '95,055 元' },
          ],
          syntheticNote: `合成人群库对照(收入档,自报式粗档):${summary(tally('income_band'))}`,
        },
        occupation: {
          title: '就业结构(三次产业)', unit: '按产业增加值构成',
          rows: [
            { value: '第一产业相关', share: 0.071, note: '增加值占比 7.1%' },
            { value: '第二产业相关', share: 0.383, note: '38.3%' },
            { value: '第三产业相关', share: 0.546, note: '54.6%' },
          ],
          syntheticNote: `合成人群库对照(职业大类):${summary(tally('occupation_group'))}`,
        },
      },
      synthetic: {
        gender: tally('gender'),
        ageBand: tally('age_band'),
        cityTier: tally('city_tier'),
        incomeBand: tally('income_band'),
        occupationGroup: tally('occupation_group'),
      },
    };
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
