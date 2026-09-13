/** 文本归一:别名/实体匹配前的清洗(全角半角、空白、装饰符号)。 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・\-–—_]/g, '')
    .replace(/[()（）【】\[\]{}「」『』]/g, '')
    .replace(/[“”"'‘’]/g, '')
    .replace(/[。,、;;!!??…]/g, '');
}

/** 编辑距离(小串专用,阈值判定用)。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}
