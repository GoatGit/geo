/** 列表结构识别(docs/05 §2 即时抽取步骤 1-2):规则优先,LLM 兜底由上层接入。 */

export interface ExtractedItem {
  /** 清洗后的实体名 */
  name: string;
  /** 有序列表位次(1-based);无序/段落为 null */
  rank: number | null;
  /** 在全部抽取项中的序号(0-based) */
  itemIndex: number;
  raw: string;
}

const ORDERED = /^\s*(\d{1,2})\s*[.、)）．:：]\s*(.+)$/;
const CN_ORDERED = /^\s*第\s*(\d{1,3})\s*名\s*[::]?\s*(.+)$/;
const UNORDERED = /^\s*[-*•·]\s+(.+)$/;
/** 小数误判:'30.98 万元起' 的 '30.' 是数字小数点而非序号(句点类分隔符且紧跟数字,中间无空白)。 */
const DECIMAL_LIKE = /^\s*\d{1,2}[.．]\d/;
/** docs/02 §1.2 位次口径:1..99,越界数字行不作为列表项。 */
const MIN_RANK = 1;
const MAX_RANK = 99;

/** 清洗 markdown 装饰:链接取锚文本、去加粗/斜体/行内代码。 */
export function cleanMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * 单行判定:收录为列表项则返回条目,否则返回 null(该行留在散文域)。
 * extractListItems 与 proseText 共用本判定,保证「剔除的行 = 收录的行」,
 * 不再出现超长行被列表跳过、又被散文剔除的两头落空。
 */
function classifyLine(line: string): Omit<ExtractedItem, 'itemIndex'> | null {
  // 超长行(>80 字符)不视为列表项,留给散文提及判定
  if (line.length > 80) return null;

  // 有序:小数前缀('30.98')先排除,再做 1..99 位次校验
  const ordered = DECIMAL_LIKE.test(line) ? null : ORDERED.exec(line);
  const cnOrdered = ordered ? null : CN_ORDERED.exec(line);
  const unordered = ordered || cnOrdered ? null : UNORDERED.exec(line);
  if (!ordered && !cnOrdered && !unordered) return null;

  const name = cleanMarkdown(
    ordered ? ordered[2] : cnOrdered ? cnOrdered[2] : unordered![1],
  );
  if (!name || name.length > 60) return null;

  const rank = ordered
    ? Number.parseInt(ordered[1], 10)
    : cnOrdered
      ? Number.parseInt(cnOrdered[1], 10)
      : null;
  if (rank !== null && (rank < MIN_RANK || rank > MAX_RANK)) return null;

  return { name, rank, raw: cleanMarkdown(line) };
}

/**
 * 从归一化 Markdown 回答中抽取列表项。
 * - 有序列表:位次 = 序号(1-based,docs/02 §1.2);位次限定 1..99,小数/越界数字行不算
 * - 无序列表:实体候选,位次 null
 * - 超长行(>80 字符)不视为列表项,留给散文提及判定
 */
export function extractListItems(markdown: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const line of markdown.split('\n')) {
    const item = classifyLine(line);
    if (item) items.push({ ...item, itemIndex: items.length });
  }
  return items;
}

/**
 * 剔除列表行后的剩余正文(散文提及判定域)。
 * 只剔除真正被 extractListItems 收录的行;超长「像列表项」的行、清洗后名称为空/过长的行
 * 均留在散文域,确保其中的品牌提及不丢失。
 */
export function proseText(markdown: string): string {
  return markdown
    .split('\n')
    .filter((l) => classifyLine(l) === null)
    .join('\n');
}
