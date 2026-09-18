/**
 * 判定提示词(docs/09 §5):口径注入 + 输出 JSON 形状 + 反幻觉约束。
 * promptVersion 变更必须同步更新 test/judge.test.ts 的契约用例(docs/09 §12)。
 */

export const INSIGHT_PROMPT_VERSION = 'p1';

export interface MentionSubjectInput {
  key: string;
  kind: string;
  name: string;
  aliases?: string[];
}

const JSON_ONLY = '只输出一个 JSON 对象,不要输出任何解释、markdown 代码块或其他文字。';

export function buildClassifyPrompt(text: string): { system: string; user: string } {
  const system = [
    '你是监测平台的问题分类器。把用户配置的监控问题分为两类:',
    '- ranking(排名词):用户想问"有哪些/推荐哪些/排行/哪个好/怎么选",期待一份带顺序或候选清单的回答;',
    '- reputation(口碑词):用户想问某品牌的口碑、质量、评价、优缺点、售后、服务体验。',
    '规则:两条都像时优先 reputation;询问价格/参数对比且期待清单的归 ranking。',
    `输出 JSON:{"type":"ranking|reputation","confidence":0到1}。${JSON_ONLY}`,
  ].join('\n');
  return { system, user: text };
}

export function buildExpandPrompt(text: string, brandName: string, year: number): { system: string; user: string } {
  const system = [
    '你是监测平台的问题拓写器:把用户配置的短语式监控问题改写为消费者会真实问 AI 的自然问法。',
    `当前年份是 ${year},可自然引用,不要写死其他年份。`,
    `品牌名是「${brandName}」,只在必要时出现,不要围绕品牌生编硬造产品断言。`,
    '硬性要求:必须保留原句的核心语义成分(主体+意图);不超过 60 字;不添加原文没有的限定条件。',
    `输出 JSON:{"question":"改写后的自然问法"}。${JSON_ONLY}`,
  ].join('\n');
  return { system, user: text };
}

export function buildMentionPrompt(input: {
  question: string;
  answerMarkdown: string;
  subjects: MentionSubjectInput[];
}): { system: string; user: string } {
  const subjectLines = input.subjects
    .map((s) => `- key=${s.key} | 名称=${s.name}${s.aliases?.length ? ` | 别名=${s.aliases.join('/')}` : ''}`)
    .join('\n');
  const system = [
    '你是品牌可见性监测的判定器。给定一条 AI 引擎对监测问题的回答,判定每个监测主体是否被提及、排位第几。',
    '判定规则:',
    '1. mentioned=true 当且仅当回答以名称、别名或明确的指代(如同一段落语境下的"这款车"紧邻品牌上下文)提到该主体;同义/变体/简称都算;',
    '2. rank:仅当回答存在明确的顺序结构(编号列表、"第一/其次"等显式排位)时给出整数位次(从 1 开始);散文式提及、无序清单一律 null;同一段落并列出现多个主体的取 null;',
    '3. excerpt:必须从回答原文逐字摘录 ≤120 字,证明该判定;禁止改写、翻译或拼接;',
    '4. 只输出 subjects 里给出的 key,禁止编造;某主体未被提及则 mentioned=false、rank=null、excerpt 留空;',
    '5. 回答为空或与问题无关时 answerEmpty=true。',
    `输出 JSON:{"answerEmpty":bool,"subjects":[{"key":"…","mentioned":bool,"rank":int或null,"confidence":0到1,"excerpt":"…"}]},subjects 必须覆盖全部输入主体。${JSON_ONLY}`,
  ].join('\n');
  const user = `【监测问题】\n${input.question}\n\n【监测主体】\n${subjectLines}\n\n【AI 回答原文】\n${input.answerMarkdown.slice(0, 12_000)}`;
  return { system, user };
}

export function buildReputationPrompt(input: { brandName: string; answerText: string }): { system: string; user: string } {
  const system = [
    `你是口碑分析器。分析 AI 回答中对品牌「${input.brandName}」(下称"本品")的评价。`,
    '判定规则:',
    '1. sentiment 只针对本品的整体口碑:竞品被吐槽不影响本品;无法判断时给 "neu";',
    '2. 必须处理否定与转折:"不推荐/没有投诉/除了贵都好"——按实际语义判,不按关键词表面;',
    '3. impressions:抽取对本品的具体评价短语(短语级,如"续航扎实""售后响应慢"),polarity 按语义给 pos/neg,每条必须携带原文逐字摘录 ≤120 字;最多 10 条;',
    '4. confidence 为你对本次判定的把握(0 到 1)。',
    `输出 JSON:{"sentiment":"pos|neu|neg","confidence":0到1,"impressions":[{"term":"…","polarity":"pos|neg","excerpt":"…"}]}。${JSON_ONLY}`,
  ].join('\n');
  return { system, user: input.answerText.slice(0, 12_000) };
}
