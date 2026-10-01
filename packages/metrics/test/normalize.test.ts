import { describe, expect, it } from 'vitest';
import { normalizeKeepSeparators, normalizeText } from '../src/normalize';

describe('全角半角归一(NFKC,引擎输出实测形态)', () => {
  it('全角数字/字母归一到半角:SU７ 命中 SU7、ｑｗｅｎ 命中 qwen', () => {
    expect(normalizeText('SU７')).toBe(normalizeText('SU7'));
    expect(normalizeText('ｑｗｅｎ')).toBe(normalizeText('qwen'));
    expect(normalizeText('ＡＩ眼镜')).toBe(normalizeText('AI眼镜'));
  });

  it('normalizeKeepSeparators 同样做 NFKC,且保留词界', () => {
    expect(normalizeKeepSeparators('Ｏｐｅｎ ＡＩ')).toBe(normalizeKeepSeparators('open ai'));
  });
});
