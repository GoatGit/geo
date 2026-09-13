import type { EvidencePointer } from '@geo/shared';
import { editDistance, normalizeText } from './normalize';

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

/**
 * 识别口径匹配(docs/02 §1.2):精确 → 别名 → 模糊(编辑距离,LLM 兜底由上层管线接)。
 * 教训 #1(A1)的对策入口:别名单一事实源在此生效——SU7/YU7 归一为本品。
 */
export function matchSubject(text: string, subjects: SubjectDef[]): SubjectMatch | null {
  const norm = normalizeText(text);
  let best: SubjectMatch | null = null;

  for (const subject of subjects) {
    const candidates: Array<{ word: string; method: 'exact' | 'alias' }> = [
      { word: subject.name, method: 'exact' },
      ...subject.aliases.map((a) => ({ word: a, method: 'alias' as const })),
    ];

    for (const { word, method } of candidates) {
      const nw = normalizeText(word);
      if (!nw) continue;
      if (norm.includes(nw)) {
        // 精确/别名包含命中;更短别名(如"小米")优先级让位给更长命中
        const confidence = method === 'exact' ? 0.95 : 0.9;
        if (!best || nw.length > normalizeText(best.hitWord).length) {
          best = { subject, method, hitWord: word, confidence };
        }
      }
    }
  }

  if (best) return best;

  // 模糊兜底:编辑距离 ≤1 且长度足够(防"小米SU7 Ultra"变体拼写),低置信进抽检池
  for (const subject of subjects) {
    const words = [subject.name, ...subject.aliases];
    for (const word of words) {
      const nw = normalizeText(word);
      if (nw.length < FUZZY_MIN_LEN) continue;
      if (editDistance(norm, nw) <= 1) {
        return { subject, method: 'fuzzy', hitWord: word, confidence: 0.55 };
      }
    }
  }
  return null;
}

/** 从原文中截取命中片段(证据链要求,docs/02 §1.2)。 */
export function makeEvidence(hitWord: string, context: string, position: number): EvidencePointer {
  const idx = context.indexOf(hitWord);
  const start = Math.max(0, (idx === -1 ? 0 : idx) - 20);
  const snippet = context.slice(start, start + 80).trim();
  return { hitWord, snippet, position };
}
