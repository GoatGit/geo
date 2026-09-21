/**
 * 引用源标题净化(采集写入与页面读取共用,双端生效):
 * 引擎引用区锚文本常见三类脏数据——引用样板句("引用 22 篇资料作为参考")、
 * 裸 URL 当标题、CDP/上游按 latin1/cp1252 转码产生的 mojibake("ç»å…³æ–°é»")。
 * 空标题是诚实信号(展示层回退「未取到标题」),脏标题比空标题更误导,宁缺毋滥。
 */

const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;
/** 引擎引用区的样板锚文本:是交互文案/统计句,不是来源页面标题。 */
const BOILERPLATE = [
  /^引用\s*\d*\s*(篇|个|条|项)?\s*(资料|来源|引用|网页|结果)?(作为)?(参考|来源)?$/,
  /^(?:查看|展开|收起|更多|全部)\s*(?:更多|全部)?\s*\d*\s*(?:条)?\s*(?:资料|来源|引用|参考)/,
  /^(?:参考资料?|来源|引用|参考来源|引用来源)$/,
  /^(资料)?来源[:：]?$/,
];

/** cp1252 高区(0x80-0x9F)与 Unicode 的对应:latin1 简单还原对 €/"/… 等字符会丢字节。 */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** cp1252 mojibake → 原始 UTF-8 文本;含不可逆字符或解码失败返回 null。 */
function mojibakeToUtf8(s: string): string | null {
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff) bytes.push(cp);
    else if (CP1252_HIGH[cp] !== undefined) bytes.push(CP1252_HIGH[cp]);
    else return null; // 混有正常区文字,不是纯 mojibake,不修
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return out.includes('\uFFFD') ? null : out;
  } catch {
    return null;
  }
}

/**
 * latin1/cp1252 误读形态判定:连续 ≥2 个高区字符且其中至少一个是 ≥U+00C0 的重音区字母
 * (CJK 的 UTF-8 首字节 E4-E9 全落在 C0-FF,真乱码必命中)。不能只看 [\u00c0-\u00ff]
 * 配对——"ç›¸å…³æ–°é—»"里 ›(U+203A) 超出 \u00FF 会断对(gcmct.com 事故);
 * 也不能把 ——/…/” 这类中文排版字符(全部 <C0)当乱码,会误杀正常标题。
 */
function looksMojibake(t: string): boolean {
  let run = 0;
  for (const ch of Array.from(t)) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x80 && cp <= 0xff) || CP1252_HIGH[cp] !== undefined) {
      run += 1;
      if (run >= 2 && cp >= 0xc0 && cp <= 0xff) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** 净化一条引用标题;不可修复/样板/URL 形态一律返回 null。展示截断 60 字。 */
export function sanitizeCitationTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (looksMojibake(t)) {
    // 循环还原覆盖双重编码
    let guard = 0;
    while (guard < 3) {
      const fixed = mojibakeToUtf8(t);
      if (!fixed) break;
      t = fixed;
      if (!looksMojibake(t)) break;
      guard += 1;
    }
    if (looksMojibake(t)) {
      // 修不动:混有 CJK 的是截断/混写的脏数据;纯拉丁串可能是真实小语种标题,保留原文
      return /[\u4e00-\u9fff]/.test(t) ? null : t;
    }
    t = t.replace(/\s+/g, ' ').trim();
  }
  if (t.length < 2 || t.length > 120) return null;
  if (URL_LIKE.test(t)) return null;
  if (BOILERPLATE.some((re) => re.test(t))) return null;
  const chars = Array.from(t);
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : t;
}
