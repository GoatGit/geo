import type { EvidencePointer } from '@geo/shared';
import { editDistance, normalizeKeepSeparators, normalizeText } from './normalize';

/** 参与匹配的口径主体(本品/竞品,均含别名,docs/01 §3.1 识别口径)。 */
export interface SubjectDef {
  key: string;
  kind: 'self' | 'competitor' | 'discovered';
  name: string;
  aliases: string[];
}

export interface SubjectMatch {
  subject: SubjectDef;
  method: 'exact' | 'alias' | 'fuzzy';
  hitWord: string;
  confidence: number;
}

const FUZZY_MIN_LEN = 4;
const ASCII_WORD = /^[a-z0-9]+$/;
const WORD_CHAR = /[a-z0-9]/;

/**
 * 在归一文本 hay 中查找 nw,并做 ASCII 词边界约束:
 * - nw 含非 [a-z0-9] 字符(含 CJK)→ 保持 includes 行为即命中。
 *   中文无分词边界、归一化又删除了中文标点,「前后字符」无法构成词界——这是已知口径限制,
 *   误命中(如「比亚迪」命中「比亚迪海豹」文本的子串场景)由别名体系与人工抽检兜底。
 * - nw 是纯 ASCII 字母数字 → 命中处前/后字符不得是 [a-z0-9],否则视为更长单词的一部分
 *   (如 brand 'meta' 命中 'metadata')而不算提及;字符串首尾视为边界。
 */
function hasBoundaryHit(hay: string, nw: string): boolean {
  const asciiWord = ASCII_WORD.test(nw);
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(nw, from);
    if (idx === -1) return false;
    if (!asciiWord) return true;
    const before = idx > 0 ? hay[idx - 1] : '';
    const after = idx + nw.length < hay.length ? hay[idx + nw.length] : '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = idx + 1;
  }
}

/**
 * 精确/别名包含判定,双视角:
 * 1) 词界版归一(normBounded,空白/分隔符压成空格):捕获原文中实际连续的出现并验边界,
 *    使 'use meta now' 命中 'meta' 而 'metadata' 不命中;
 * 2) 全删版归一(norm):捕获跨分隔拼接的出现('su 7'→'su7'),保持既有口径。
 * 任一视角边界合法即命中。
 */
function containsSubject(norm: string, normBounded: string, nw: string): boolean {
  return hasBoundaryHit(normBounded, nw) || hasBoundaryHit(norm, nw);
}

/**
 * 模糊兜底:整条回答全文与词做编辑距离在长文本上永不可达(长度几乎必须相等)。
 * 改为滑窗:在归一文本上取长度为 nw.length-1 / nw.length / nw.length+1、步长 1 的窗口,
 * 任一窗口与 nw 编辑距离 ≤1 即命中(method='fuzzy')。保留 FUZZY_MIN_LEN 下限防短词误命中。
 * 滑窗在词界版归一上进行,且 nw 为纯 ASCII 时窗口前后不得是 [a-z0-9]:
 * 否则 'metadata' 会经窗口 'meta'(距离 0)击穿精确匹配的词边界约束。
 */
function fuzzyWindowHit(hay: string, nw: string): boolean {
  if (nw.length < FUZZY_MIN_LEN) return false;
  const asciiWord = ASCII_WORD.test(nw);
  for (let len = nw.length - 1; len <= nw.length + 1; len++) {
    if (len <= 0) continue;
    for (let start = 0; start + len <= hay.length; start++) {
      if (editDistance(hay.slice(start, start + len), nw) > 1) continue;
      if (asciiWord) {
        const before = start > 0 ? hay[start - 1] : '';
        const after = start + len < hay.length ? hay[start + len] : '';
        if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * 识别口径匹配(docs/02 §1.2):精确 → 别名 → 模糊(编辑距离,LLM 兜底由上层管线接)。
 * 教训 #1(A1)的对策入口:别名单一事实源在此生效——SU7/YU7 归一为本品。
 * @param normalized 可选:调用方已归一的文本(批量场景避免循环内重复归一),与 text 二选一
 */
export function matchSubject(
  text: string,
  subjects: SubjectDef[],
  normalized?: string,
): SubjectMatch | null {
  const norm = normalized ?? normalizeText(text);
  const normBounded = normalizeKeepSeparators(text);
  let best: SubjectMatch | null = null;

  for (const subject of subjects) {
    const candidates: Array<{ word: string; method: 'exact' | 'alias' }> = [
      { word: subject.name, method: 'exact' },
      ...subject.aliases.map((a) => ({ word: a, method: 'alias' as const })),
    ];

    for (const { word, method } of candidates) {
      const nw = normalizeText(word);
      if (!nw) continue;
      if (containsSubject(norm, normBounded, nw)) {
        // 精确/别名包含命中;更短别名(如"小米")优先级让位给更长命中
        const confidence = method === 'exact' ? 0.95 : 0.9;
        if (!best || nw.length > normalizeText(best.hitWord).length) {
          best = { subject, method, hitWord: word, confidence };
        }
      }
    }
  }

  if (best) return best;

  // 模糊兜底:滑窗编辑距离 ≤1 且长度足够(防"小米SU7 Ultra"变体拼写),低置信进抽检池
  for (const subject of subjects) {
    const words = [subject.name, ...subject.aliases];
    for (const word of words) {
      const nw = normalizeText(word);
      if (fuzzyWindowHit(normBounded, nw)) {
        return { subject, method: 'fuzzy', hitWord: word, confidence: 0.55 };
      }
    }
  }
  return null;
}

/** 从原文中截取命中片段(证据链要求,docs/02 §1.2)。 */
export function makeEvidence(hitWord: string, context: string, position: number): EvidencePointer {
  let idx = -1;
  // 优先使用调用方给定的 position:校验该处切片确为命中词(忽略大小写,兼容原文大小写差异)
  if (
    position >= 0 &&
    position <= context.length - hitWord.length &&
    context.slice(position, position + hitWord.length).toLowerCase() === hitWord.toLowerCase()
  ) {
    idx = position;
  }
  if (idx === -1) idx = context.indexOf(hitWord);
  const start = Math.max(0, (idx === -1 ? 0 : idx) - 20);
  const snippet = context.slice(start, start + 80).trim();
  return { hitWord, snippet, position };
}
