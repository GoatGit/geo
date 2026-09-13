import { describe, expect, it } from 'vitest';
import { parseBrandDescription } from '../src/brands/brand-intelligence';

describe('parseBrandDescription(docs/01 §3.1 规则引擎基线)', () => {
  const description =
    '我的品牌叫「小米汽车」,是小米公司旗下的智能电动汽车品牌,主打高性能纯电轿车和SUV,' +
    '官网是 https://www.xiaomiev.com ,主要竞品是特斯拉、比亚迪、蔚来和极氪';

  it('抽取品牌名(引号优先)/ 行业 / 官网', () => {
    const d = parseBrandDescription(description);
    expect(d.name).toBe('小米汽车');
    expect(d.industry).toBe('新能源汽车');
    expect(d.website).toBe('https://www.xiaomiev.com');
  });

  it('竞品清单来自描述,逐项拆分', () => {
    const d = parseBrandDescription(description);
    expect(d.suggestedCompetitors.map((c) => c.name)).toEqual(['特斯拉', '比亚迪', '蔚来', '极氪']);
  });

  it('A1 对策:建议别名包含自有产品线型号(如 SU7/YU7)', () => {
    const d = parseBrandDescription(
      '品牌叫「某新势力」,产品线有 SU7、YU7 和 Model 3 对标车型',
    );
    expect(d.suggestedAliases).toContain('SU7');
    expect(d.suggestedAliases).toContain('YU7');
  });
});
