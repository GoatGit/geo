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
});
