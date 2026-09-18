import { describe, expect, it } from 'vitest';
import { makeEvidence, matchSubject, type SubjectDef } from '../src/match';

describe('matchSubject 模糊兜底(滑窗口径)', () => {
  const su7: SubjectDef[] = [{ key: 'self:xiaomi', kind: 'self', name: '小米SU7', aliases: [] }];

  it('1 字之差在长文本中命中 fuzzy(原整串编辑距离为死逻辑,永不可达)', () => {
    const m = matchSubject('综合来看小来su7是一款不错的车', su7);
    expect(m).not.toBeNull();
    expect(m!.method).toBe('fuzzy');
    expect(m!.confidence).toBeLessThan(0.8);
  });

  it('完全不相关长文本不误命中', () => {
    const text =
      '今天聊聊家常菜的做法,红烧肉要先焯水,炒糖色记得用小火慢慢熬,加一点料酒去腥,' +
      '最后撒上葱花就可以出锅了,味道咸鲜微甜,配米饭吃一绝,大人小孩都爱吃,' +
      '周末做上一锅全家围坐在一起,热气腾腾的,幸福就是这么简单,记得多焖一点米饭,不然不够分。';
    expect(matchSubject(text, su7)).toBeNull();
  });

  it('低于 FUZZY_MIN_LEN 的词不做模糊兜底(防短词误命中)', () => {
    // 「su7」长度 3 < 4:「智界 S7」与之仅 1 字之差,不得模糊命中
    const s: SubjectDef[] = [{ key: 'self:xiaomi', kind: 'self', name: 'SU7', aliases: [] }];
    expect(matchSubject('智界 S7 值得考虑', s)).toBeNull();
  });
});

describe('matchSubject 精确匹配 ASCII 词边界', () => {
  const meta: SubjectDef[] = [{ key: 'c:meta', kind: 'competitor', name: 'meta', aliases: [] }];

  it("brand 'meta' 不命中 'metadata'(词中子串)", () => {
    expect(matchSubject('这是一段 metadata 说明文字', meta)).toBeNull();
  });

  it("brand 'meta' 命中独立词 'use meta now'", () => {
    const m = matchSubject('use meta now', meta);
    expect(m).not.toBeNull();
    expect(m!.method).toBe('exact');
    expect(m!.confidence).toBe(0.95);
  });

  it("brand 'meta' 不命中紧贴字母的串(词界约束)", () => {
    expect(matchSubject('元数据 metadatax 是更长的单词', meta)).toBeNull();
  });

  it('CJK 词保持 includes 行为(中文无分词边界,已知口径限制)', () => {
    const byd: SubjectDef[] = [
      { key: 'c:byd', kind: 'competitor', name: '比亚迪', aliases: [] },
    ];
    const m = matchSubject('对比亚迪海豹的评价', byd);
    expect(m).not.toBeNull();
    expect(m!.method).toBe('exact');
  });

  it('跨分隔拼接保持旧口径:su 7 命中 SU7', () => {
    const s: SubjectDef[] = [{ key: 'self:xiaomi', kind: 'self', name: 'SU7', aliases: [] }];
    const m = matchSubject('推荐 su 7 这款车', s);
    expect(m).not.toBeNull();
    expect(m!.method).toBe('exact');
  });
});

describe('makeEvidence(position 口径)', () => {
  it('大小写不一致时优先使用 position 截取命中片段', () => {
    const prefix = 'x'.repeat(50);
    const context = `${prefix} xiaomi SU7 ${'y'.repeat(60)}`;
    const position = prefix.length + 1;
    const ev = makeEvidence('Xiaomi SU7', context, position);
    // 旧逻辑:indexOf 大小写不符 → idx=-1 → 从头截 80,不含命中词
    expect(ev.snippet).toContain('xiaomi SU7');
    expect(ev.position).toBe(position);
  });

  it('position 处切片与命中词不符时回退 indexOf', () => {
    const context = 'hello Xiaomi SU7 world';
    const ev = makeEvidence('Xiaomi SU7', context, 0); // slice(0,10)="hello Xiaom" ≠
    expect(ev.snippet).toContain('Xiaomi SU7');
  });

  it('position 越界或完全找不到时保持现状(从头截 80)', () => {
    const context = 'a'.repeat(100);
    const ev = makeEvidence('Xiaomi SU7', context, 9999);
    expect(ev.snippet.length).toBeLessThanOrEqual(80);
    expect(ev.position).toBe(9999);
  });
});
