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
});
