import { PARSER_VERSION, type MentionFactDraft } from '@geo/shared';
import { extractListItems, proseText } from './extract';
import { makeEvidence, matchSubject, type SubjectDef, type SubjectMatch } from './match';
import { normalizeText } from './normalize';

/**
 * 即时抽取(docs/05 §2):提及与位次判定,产出 mention_facts 草稿。
 * - 列表项命中 → mentioned=true, rank=列表序;同列表项多主体并存 → co_ranked(拆多条事实)
 * - 散文式提及 → mentioned=true, rank=null(docs/02 §1.2)
 * - 未命中 → mentioned=false(计入分母,视为"未提及")
 * - 模糊匹配置信度 <0.8 → confidence 标低,上层管线转入人工抽检池(docs/05 §3.2)
 */
export function buildMentionFacts(input: {
  runId: string;
  brandId: number;
  subjects: SubjectDef[];
  markdown: string;
  parserVersion?: string;
}): MentionFactDraft[] {
  const { runId, brandId, subjects, markdown } = input;
  const parserVersion = input.parserVersion ?? PARSER_VERSION;

  // 每个 subject:列表命中(取最小位次) > 散文命中 > 未提及
  const byKey = new Map<string, MentionFactDraft>();
  const ensure = (s: SubjectDef): MentionFactDraft => {
    let f = byKey.get(s.key);
    if (!f) {
      f = {
        runId,
        brandId,
        subjectKind: s.kind,
        subjectKey: s.key,
        subjectName: s.name,
        mentioned: false,
        rank: null,
        coRanked: false,
        evidence: null,
        parserVersion,
        confidence: 1,
      };
      byKey.set(s.key, f);
    }
    return f;
  };
  for (const s of subjects) ensure(s);

  const items = extractListItems(markdown);

  // 1) 列表项:同一项命中多个主体 → co_ranked
  for (const item of items) {
    // 每个列表项只归一一次(原先每列表项 × 每 subject 重复归一整段文本)
    const normItemName = normalizeText(item.name);
    const matches = collectMatchesInText(item.name, normItemName, subjects);
    if (matches.length === 0) continue;
    for (const m of matches) {
      const fact = ensure(m.subject);
      const better =
        !fact.mentioned || (fact.rank === null && item.rank !== null) ||
        (item.rank !== null && fact.rank !== null && item.rank < fact.rank!);
      // better=false 时第三子条件必为 false,原 else-if 是永不可达的死分支,已删除
      if (better) {
        fact.mentioned = true;
        fact.rank = item.rank;
        fact.evidence = makeEvidence(m.hitWord, item.raw, item.itemIndex);
        fact.confidence = m.confidence;
      }
      if (matches.length > 1) fact.coRanked = true;
    }
  }

  // 2) 散文提及(列表未命中的主体)
  const prose = proseText(markdown);
  for (const s of subjects) {
    const fact = byKey.get(s.key)!;
    if (fact.mentioned) continue;
    const m = matchSubject(prose, [s]);
    if (m) {
      fact.mentioned = true;
      fact.rank = null;
      fact.evidence = makeEvidence(m.hitWord, prose, prose.indexOf(m.hitWord));
      fact.confidence = m.confidence;
    }
  }

  return [...byKey.values()];
}

/**
 * 逐主体匹配列表项文本;归一结果由调用方传入(每列表项归一一次),
 * 避免旧实现每列表项 × 每 subject 重复归一整段文本。
 */
function collectMatchesInText(
  text: string,
  normText: string,
  subjects: SubjectDef[],
): SubjectMatch[] {
  const out: SubjectMatch[] = [];
  for (const s of subjects) {
    const m = matchSubject(text, [s], normText);
    if (m) out.push(m);
  }
  return out;
}
