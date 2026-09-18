import { describe, expect, it } from 'vitest';
import { extractListItems, proseText } from '../src/extract';

const SAMPLE = `在 20 万左右预算内,以下纯电轿车值得考虑:

1. **小米 SU7** —— 性价比高
2. 比亚迪海豹
3. [特斯拉 Model 3](https://www.tesla.com/model3)

另外还有:

- 极氪 001
- 小鹏 P7

第 4 名:零跑 C01

这是一段很长的散文,不构成列表项,因为超过八十个字符的行会被过滤掉,主要用来讨论预算、续航、智能化体验等等等这是一个很长的段落没错很长。`;

describe('extractListItems', () => {
  it('解析有序列表并保留 1-based 位次', () => {
    const items = extractListItems(SAMPLE);
    const ranked = items.filter((i) => i.rank !== null);
    expect(ranked.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
    expect(ranked[0].name).toBe('小米 SU7 —— 性价比高');
    expect(ranked[2].name).toBe('特斯拉 Model 3'); // 链接取锚文本
  });

  it('无序列表位次为 null 但仍是实体候选', () => {
    const items = extractListItems(SAMPLE);
    const bullets = items.filter((i) => i.rank === null);
    expect(bullets.map((i) => i.name)).toEqual(['极氪 001', '小鹏 P7']);
  });

  it('支持「第 N 名」样式', () => {
    const items = extractListItems('第 4 名:零跑 C01');
    expect(items[0].rank).toBe(4);
    expect(items[0].name).toBe('零跑 C01');
  });

  it('过滤超长行(散文段落)', () => {
    const items = extractListItems(SAMPLE);
    expect(items.some((i) => i.name.includes('智能化体验'))).toBe(false);
  });
});

describe('proseText', () => {
  it('剔除列表行后保留散文正文', () => {
    const prose = proseText(SAMPLE);
    expect(prose).toContain('值得考虑');
    expect(prose).not.toContain('比亚迪海豹');
    expect(prose).toContain('续航、智能化');
  });

  it('超长「像列表项」的行留在散文域,品牌不两头落空', () => {
    const longListy =
      '1. 小米SU7 是一款非常值得推荐的纯电轿车,续航扎实、智能化体验出色,性价比在同级中相当突出,' +
      '售后网络也在快速铺开,全家都很满意,身边朋友问了好多次,确实很香。';
    expect(longListy.length).toBeGreaterThan(80);
    // 列表口径:超长行不收录(不产生伪造位次)
    expect(extractListItems(longListy)).toEqual([]);
    // 散文口径:同一行不被剔除,品牌仍可被提及
    const prose = proseText(`前言如下:\n${longListy}`);
    expect(prose).toContain('小米SU7');
  });

  it('短列表行被剔除,超长行保留(剔除域 = 收录域)', () => {
    const md = '开头散文\n\n1. 短列表项\n\n结尾散文';
    const prose = proseText(md);
    expect(prose).not.toContain('短列表项');
    expect(prose).toContain('开头散文');
    expect(prose).toContain('结尾散文');
  });
});

describe('数字行误判防护(docs/02 §1.2 位次 1..99)', () => {
  it("小数行 '30.98 万元起' 不作为列表项,留在散文域", () => {
    const line = '30.98 万元起售,价格有诚意';
    expect(extractListItems(line)).toEqual([]);
    expect(proseText(line)).toContain('30.98');
  });

  it('小数变体 1.5T / 12.34 均不误判', () => {
    expect(extractListItems('1.5T 发动机动力够用')).toEqual([]);
    expect(extractListItems('12.34 的用户给出好评')).toEqual([]);
  });

  it('rank 越界(0 或 ≥100)不作为列表项', () => {
    expect(extractListItems('0. 无位次实体')).toEqual([]);
    expect(extractListItems('第 100 名:超界车型')).toEqual([]);
  });

  it('边界内位次正常收录(1 与 99)', () => {
    expect(extractListItems('1. 首位车型')[0].rank).toBe(1);
    expect(extractListItems('99. 末位车型')[0].rank).toBe(99);
    expect(extractListItems('第 99 名:末位车型')[0].rank).toBe(99);
  });
});
