import { describe, expect, it } from 'vitest';
import { classifyQuestion, expandQuestion } from '../src/questions/questions.service';

describe('问题分类与拓写(docs/01 §3.2)', () => {
  it('口碑词命中:口碑/质量/售后/服务类', () => {
    expect(classifyQuestion('小米汽车的口碑怎么样?')).toBe('reputation');
    expect(classifyQuestion('小米汽车的售后服务好不好')).toBe('reputation');
    expect(classifyQuestion('20万预算纯电轿车推荐')).toBe('ranking');
  });

  it('拓写:短词 → 自然问法;已完整问句保持不变', () => {
    expect(expandQuestion('纯电轿车推荐', '小米汽车')).toContain('有什么值得推荐的吗');
    expect(expandQuestion('小米汽车的口碑怎么样?', '小米汽车')).toContain('口碑');
    const full = '在20万左右的预算内,值得购买的纯电轿车有哪些推荐?';
    expect(expandQuestion(full, '小米汽车')).toBe(full);
  });

  it('拓写:不同口碑词必须得到话题专属问句,不得坍缩成同一句(品牌9 七条同文事故回归)', () => {
    const raws = [
      '小米汽车质量怎么样',
      '小米汽车售后服务口碑',
      '小米SU7车主真实评价',
      '小米汽车保值率怎么样',
      '小米汽车投诉多吗',
      '小米汽车安全性能评价',
    ];
    const expanded = raws.map((r) => expandQuestion(r, '小米汽车'));
    expect(new Set(expanded).size).toBe(raws.length);
    // 每条问句都保留各自话题特征,不共用固定句式
    expect(expanded[0]).toContain('质量');
    expect(expanded[1]).toContain('售后');
    expect(expanded[2]).toContain('车主');
    expect(expanded[4]).toContain('投诉');
    // 短词缺品牌上下文时自动补全
    expect(expandQuestion('客服态度怎么样', '小米汽车')).toBe('小米汽车客服态度怎么样?');
  });
});
