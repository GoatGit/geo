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
 * 从归一化 Markdown 回答中抽取列表项。
 * - 有序列表:位次 = 序号(1-based,docs/02 §1.2)
 * - 无序列表:实体候选,位次 null
 * - 超长行(>80 字符)不视为列表项,留给散文提及判定
 */
export function extractListItems(markdown: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const line of markdown.split('\n')) {
    if (line.length > 80) continue;
    const ordered = ORDERED.exec(line) ?? CN_ORDERED.exec(line);
    const unordered = ordered ? null : UNORDERED.exec(line);
    if (!ordered && !unordered) continue;

    const name = cleanMarkdown(ordered ? ordered[2] : unordered![1]);
    if (!name || name.length > 60) continue;

    items.push({
      name,
      rank: ordered ? Number.parseInt(ordered[1], 10) : null,
      itemIndex: items.length,
      raw: cleanMarkdown(line),
    });
  }
  return items;
}

/** 剔除列表行后的剩余正文(散文提及判定域)。 */
export function proseText(markdown: string): string {
  const itemLines = new Set(
    markdown
      .split('\n')
      .filter((l) => ORDERED.test(l) || CN_ORDERED.test(l) || UNORDERED.test(l)),
  );
  return markdown
    .split('\n')
    .filter((l) => !itemLines.has(l))
    .join('\n');
}
