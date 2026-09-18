import { Worker, Queue } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { industryInsights, insightIndustries } from '@geo/db';
import { INSIGHTS_QUEUE, bullConnection } from './queue';
import { runInsightBuild, type InsightBuildJob } from './insight-builder';

/**
 * 行业洞察聚合消费器(docs/01 §3.10「运行」):
 * API 管理后台入队 {insightId, windowDays} → 取数+组稿 → 回写 blocks 与 build 状态。
 * 单并发即可:聚合是重查询,串行避免挤占采集库连接。
 * 另含每周一 09:00(上海)cron:为每个"有监测品牌"的活跃行业自动出报告(30 天窗口)。
 */
export function startInsightsWorker(db: Db, concurrency = 1): Worker<InsightBuildJob> {
  const worker = new Worker<InsightBuildJob>(
    INSIGHTS_QUEUE,
    async (job) => {
      if ((job.name ?? '') === 'cron-weekly') {
        await runWeeklyInsights(db);
        return;
      }
      await runInsightBuild(db, job.data);
    },
    { connection: bullConnection(), concurrency },
  );
  worker.on('error', (err) => console.error('[insights] worker error', err));
  worker.on('failed', (job, err) => console.error(`[insights] job=${job?.id} failed:`, err.message));
  return worker;
}

/** 注册周报自动生成(每周一 09:00 上海时区,晚于品牌周报 08:00,复用行业数据日结)。 */
export async function scheduleWeeklyInsights(): Promise<void> {
  const queue = new Queue(INSIGHTS_QUEUE, { connection: bullConnection() });
  await queue.add(
    'cron-weekly',
    {},
    { repeat: { pattern: '0 9 * * 1', tz: 'Asia/Shanghai' }, jobId: 'insights-cron-weekly' },
  );
  await queue.close();
}

/** cron 实现:活跃行业 × 有监测品牌 → 报告行(无则建)→ 串行聚合(30 天窗口)。 */
async function runWeeklyInsights(db: Db): Promise<void> {
  const industries = await db.select().from(insightIndustries).where(eq(insightIndustries.active, true));
  for (const industry of industries) {
    // 无监测品牌的行业跳过(聚合会抛错,不值得记录 failed)
    const hasBrands = await db.execute(sql`
      select 1 from brands where industry = ${industry.name} and status = 'active' limit 1
    `);
    if (hasBrands.rows.length === 0) continue;

    let insight = (
      await db
        .select()
        .from(industryInsights)
        .where(eq(industryInsights.industryId, industry.id))
        .orderBy(desc(industryInsights.updatedAt))
        .limit(1)
    )[0];
    if (!insight) {
      insight = (
        await db.insert(industryInsights).values({ industryId: industry.id, title: `${industry.name}行业 AI 可见度洞察` }).returning()
      )[0]!;
    }
    // 聚合中的报告跳过(手动触发正在进行)
    if (insight.buildStatus === 'running') continue;
    try {
      await runInsightBuild(db, { insightId: insight.id, windowDays: 30 });
      console.log(`[insights] weekly 自动生成完成: ${industry.name} #${insight.id}`);
    } catch (err) {
      console.error(`[insights] weekly ${industry.name} 失败:`, (err as Error).message.slice(0, 120));
    }
  }
}
