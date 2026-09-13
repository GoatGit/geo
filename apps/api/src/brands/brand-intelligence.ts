/**
 * 品牌初始化智能(docs/01 §3.1):
 * AI 解析产出的规则引擎实现 —— 从自然语言描述抽取品牌名/官网/行业/竞品清单,
 * 并按"教训 #1"对策强制建议 自有产品线别名(默认勾选,用户可增删后确认)。
 * 生产替换为 LLM 实现(DashScope),本实现保证 dev/离线可用且行为确定。
 */
export interface BrandProfileDraft {
  name: string;
  industry: string;
  website: string | null;
  intro: string;
  suggestedCompetitors: Array<{ name: string; note: string }>;
  /** 建议识别词 + 别名(含自有产品线,默认勾选) */
  suggestedAliases: string[];
}

const KNOWN_INDUSTRY_KEYWORDS: Array<[string, string[]]> = [
  ['新能源汽车', ['电动汽车', '纯电', '新能源', '汽车', 'suv', '轿车']],
  ['智能硬件', ['手机', '耳机', '手环', '音箱', '平板']],
  ['美妆个护', ['美妆', '护肤', '口红', '精华']],
  ['家电', ['空调', '冰箱', '洗衣机', '家电']],
  ['SaaS/软件', ['saas', '软件', '平台服务']],
];

export function parseBrandDescription(description: string): BrandProfileDraft {
  const website = description.match(/https?:\/\/[^\s,，;；。"”]+/)?.[0] ?? null;

  // 品牌名优先级:引号内容 > 「叫/名为/品牌是 X」> 首段前 12 字
  const quoted = description.match(/[「“"']([^」”"']{2,16})[」”"']/)?.[1];
  const afterVerb = description.match(/(?:品牌)?(?:叫|名为|是)\s*([^,，。;；"」”]{2,16})/)?.[1]?.trim();
  const fallback = description.trim().slice(0, 12);
  const name = (quoted ?? afterVerb ?? fallback).replace(/^(我的品牌|品牌)/, '').trim() || '未命名品牌';

  const lower = description.toLowerCase();
  const industry =
    KNOWN_INDUSTRY_KEYWORDS.find(([, kws]) => kws.some((k) => lower.includes(k)))?.[0] ?? '综合';

  // 竞品:显式列举(「主要竞品是 A、B、C」)
  const competitors: Array<{ name: string; note: string }> = [];
  const explicit = description.match(/(?:主要竞品|竞品)(?:是|包括|有|为)\s*([^。;；.]+)/)?.[1];
  if (explicit) {
    for (const raw of explicit.split(/[,，、和与]/)) {
      const name = raw.trim();
      if (name.length >= 2 && name.length <= 16) {
        competitors.push({ name, note: '来自品牌描述' });
      }
    }
  }

  const intro = description.trim().slice(0, 300);

  // 自有产品线别名(A1 对策):描述中的型号形如「字母+数字」组合,如 SU7 / YU7 / Model 3
  const productLines = [...new Set(description.match(/\b[A-Za-z][A-Za-z]*\d+[A-Za-z0-9-]*\b/g) ?? [])];

  return {
    name,
    industry,
    website,
    intro,
    suggestedCompetitors: competitors,
    suggestedAliases: productLines,
  };
}
