import { reputationFacts, type Db } from '@geo/db';
import { PARSER_VERSION } from '@geo/shared';
import type { ReputationJobData } from './queue';

const POS_LEXICON = ['亮点', '领先', '竞争力', '推荐', '出色', '优秀', '口碑好', '耐用', '性价比高', '生态', '做工', '热'];
const NEG_LEXICON = ['投诉', '慢', '差', '弱', '贵', '溢价', '顾虑', '槽点', '不足', '保守', '滞后', '争议'];

/**
 * 口碑批量抽取(docs/05 §3.2)的确定性基线:
 * 词库情感三分类 + 印象短语(必须携带原文摘录,docs/02 §4)。
 * 置信度固定 0.7 < 0.8 → 全量进入人工抽检池(审计闭环),生产替换 LLM 后按真实置信度过滤。
 * LLM 供应商经 LLM_PROVIDER 接入(DashScope),接口不变。
 */
export async function extractReputation(db: Db, job: ReputationJobData): Promise<void> {
  const sentences = job.answerText
    .split(/[。\n;;;!?!?]/)
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

  const sentiment = pos > neg ? 'pos' : neg > pos ? 'neg' : 'neu';
  await db.insert(reputationFacts).values({
    runId: job.runId,
    brandId: job.brandId,
    sentiment,
    confidence: 0.7,
    impressionTerms: terms,
    excerpt: sentences[0] ?? null,
    auditState: 'pending',
    ranAt: new Date(job.ranAt),
    parserVersion: PARSER_VERSION,
  });
}
