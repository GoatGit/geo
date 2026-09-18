import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { brands, loadPlatformSettings, reputationFacts, type Db } from '@geo/db';
import { PARSER_VERSION } from '@geo/shared';
import type { ReputationJobData } from './queue';
import { createInsightAgent, incrInsightStat } from './insight';

const POS_LEXICON = ['亮点', '领先', '竞争力', '推荐', '出色', '优秀', '口碑好', '耐用', '性价比高', '生态', '做工', '热'];
const NEG_LEXICON = ['投诉', '慢', '差', '弱', '贵', '溢价', '顾虑', '槽点', '不足', '保守', '滞后', '争议'];

/** 规则基线(降级路径,docs/09 §1.1):词库情感三分类 + 印象短语。 */
function ruleSentiment(
  answerText: string,
): { sentiment: 'pos' | 'neu' | 'neg'; terms: Array<{ term: string; polarity: 'pos' | 'neg'; excerpt: string }> } {
  const sentences = answerText
    .split(/[。;;\n!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  let pos = 0;
  let neg = 0;
  const terms: Array<{ term: string; polarity: 'pos' | 'neg'; excerpt: string }> = [];
  for (const s of sentences) {
    const hitsPos = POS_LEXICON.filter((w) => s.includes(w));
    const hitsNeg = NEG_LEXICON.filter((w) => s.includes(w));
    pos += hitsPos.length;
    neg += hitsNeg.length;
    for (const w of hitsPos) terms.push({ term: w, polarity: 'pos', excerpt: s.slice(0, 120) });
    for (const w of hitsNeg) terms.push({ term: w, polarity: 'neg', excerpt: s.slice(0, 120) });
  }
  return { sentiment: pos > neg ? 'pos' : neg > pos ? 'neg' : 'neu', terms };
}

/**
 * 证据摘要(docs/05 §3.2 页面"原文证据"):跳过回答开头的元信息行
 * ("搜索 N 个关键词/已完成分析,共参考 N 篇")与问题回显(元宝回答容器含用户气泡),
 * 取第一句真实内容;全被跳过时退回首条印象短语摘要。
 */
function pickExcerpt(answerText: string, questionText: string | undefined, terms: Array<{ excerpt: string }>): string | null {
  const noise = /^搜索|^已搜索|^已完成分析|^共参考|篇资料[。]?$/;
  const q = (questionText ?? '').replace(/\s+/g, '');
  for (const raw of answerText.split(/[。;;\n!?]/)) {
    const s = raw.trim();
    if (s.length < 12) continue;
    if (noise.test(s)) continue;
    const norm = s.replace(/\s+/g, '');
    if (q && (norm.includes(q) || (norm.length <= q.length + 4 && q.includes(norm)))) continue; // 问题回显
    return s.slice(0, 120);
  }
  return terms[0]?.excerpt ?? null;
}

/**
 * 口碑批量抽取(docs/05 §3.2)的判定层 = Insight Agent(docs/09 §6):
 * mode=llm → LLM 判定(高置信 ≥0.9 写 auditState='auto' 免抽检,否则入池),失败自动回落词库规则;
 * mode=shadow → 口径仍走规则,LLM 判定写 query_runs.meta.insightShadow 对比;
 * mode=rules / 未启用 → 词库规则(现状行为,confidence 0.7 全量入抽检池)。
 * LLM 供应商经管理后台 Insight Agent 配置(docs/09 §4)。
 */
export async function extractReputation(db: Db, job: ReputationJobData, redis?: Redis | null): Promise<void> {
  if (!job.answerText || !job.answerText.trim()) return; // 空回答无可抽取
  const ranAt = Number.isNaN(new Date(job.ranAt).getTime()) ? new Date() : new Date(job.ranAt);
  const rule = ruleSentiment(job.answerText);

  let sentiment = rule.sentiment;
  let confidence = 0.7;
  let terms = rule.terms;
  let auditState: 'pending' | 'auto' = 'pending';
  let parserVersion = PARSER_VERSION;

  const cfg = (await loadPlatformSettings(db)).insightAgent;
  if (cfg.enabled && cfg.mode !== 'rules') {
    const brandName =
      (await db.select({ name: brands.name }).from(brands).where(eq(brands.id, job.brandId)).limit(1))[0]?.name ?? '';
    const agent = createInsightAgent(cfg, redis ?? null);
    const judged = await agent.judgeReputation({ brandName, answerText: job.answerText });
    if (judged) {
      if (cfg.mode === 'llm') {
        sentiment = judged.sentiment;
        confidence = judged.confidence;
        terms = judged.impressions.map((t) => ({ term: t.term, polarity: t.polarity, excerpt: t.excerpt.slice(0, 120) }));
        auditState = judged.confidence >= 0.9 ? 'auto' : 'pending';
        parserVersion = judged.parserVersion;
      } else {
        // 影子:口径保持规则结果,差异计数 + 双侧判定入 meta(docs/09 §7)
        const agree = rule.sentiment === judged.sentiment;
        if (!agree) void incrInsightStat(redis, 'shadow_disagree');
        await db
          .execute(sql`
            update query_runs
            set meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({
              insightShadow: {
                task: 'reputation',
                agree,
                rule: rule.sentiment,
                llm: judged.sentiment,
                impressions: judged.impressions.length,
                parserVersion: judged.parserVersion,
              },
            })}::jsonb
            where id = ${job.runId}
          `)
          .catch((err) => console.error(`[insight] reputation shadow write failed run=${job.runId}:`, err));
      }
    }
    // judged 为 null(LLM 失败):mode=llm 时保持规则结果(confidence 0.7 天然入抽检池),降级事件已由 agent 记录
  }

  await db.insert(reputationFacts).values({
    runId: job.runId,
    brandId: job.brandId,
    sentiment,
    confidence,
    impressionTerms: terms,
    excerpt: pickExcerpt(job.answerText, job.questionText, terms),
    auditState,
    ranAt,
    parserVersion,
  });
}
