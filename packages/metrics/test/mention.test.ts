import { describe, expect, it } from 'vitest';
import { buildMentionFacts } from '../src/mention';
import type { SubjectDef } from '../src/match';

const subjects: SubjectDef[] = [
  { key: 'self:xiaomi', kind: 'self', name: '小米汽车', aliases: ['小米 SU7', '小米 YU7', 'SU7', 'YU7'] },
  { key: 'comp:byd', kind: 'competitor', name: '比亚迪', aliases: ['海豹', '汉 EV'] },
  { key: 'comp:tesla', kind: 'competitor', name: '特斯拉', aliases: ['Model 3'] },
];

const ANSWER = `值得推荐的纯电轿车:

1. 小米 SU7(性价比突出)
2. 比亚迪海豹
3. 特斯拉 Model 3

从市场口碑看,小米汽车的品牌热度很高。`;

describe('buildMentionFacts', () => {
  it('列表命中:本品与竞品按列表序取得位次,证据含命中词与片段', () => {
    const facts = buildMentionFacts({ runId: 'r1', brandId: 1, subjects, markdown: ANSWER });
    const self = facts.find((f) => f.subjectKey === 'self:xiaomi')!;
    expect(self.mentioned).toBe(true);
    expect(self.rank).toBe(1);
    expect(self.evidence?.hitWord).toBe('小米 SU7');
    expect(self.evidence?.snippet).toContain('性价比');

    const byd = facts.find((f) => f.subjectKey === 'comp:byd')!;
    expect(byd.rank).toBe(2);

    const tesla = facts.find((f) => f.subjectKey === 'comp:tesla')!;
    expect(tesla.rank).toBe(3);
  });

  it('散文式提及:mentioned=true 且 rank=null(docs/02 §1.2)', () => {
    const facts = buildMentionFacts({
      runId: 'r2',
      brandId: 1,
      subjects: [subjects[0]],
      markdown: '整体来看,小米汽车的热度很高,但列表里我们更推荐其他车型:\n\n1. 极氪 001\n2. 智界 S7',
    });
    const self = facts[0];
    expect(self.mentioned).toBe(true);
    expect(self.rank).toBeNull();
    expect(self.evidence).not.toBeNull();
  });

  it('未提及:mentioned=false,计入分母视为"未提及"', () => {
    const facts = buildMentionFacts({
      runId: 'r3',
      brandId: 1,
      subjects,
      markdown: '推荐如下:\n\n1. 极氪 001\n2. 智界 S7\n3. 深蓝 SL03',
    });
    for (const f of facts) {
      expect(f.mentioned).toBe(false);
      expect(f.rank).toBeNull();
      expect(f.evidence).toBeNull();
    }
  });

  it('别名单一事实源生效:YU7 归一为本品(教训 #1/A1 对策)', () => {
    const facts = buildMentionFacts({
      runId: 'r4',
      brandId: 1,
      subjects,
      markdown: '推荐:\n\n1. 小米 YU7\n2. 特斯拉 Model Y',
    });
    const self = facts.find((f) => f.subjectKey === 'self:xiaomi')!;
    expect(self.mentioned).toBe(true);
    expect(self.rank).toBe(1);
    expect(self.subjectName).toBe('小米汽车'); // 归一后 subjectName 不再出现"小米 YU7"
  });

  it('同一列表项命中多主体 → co_ranked', () => {
    const facts = buildMentionFacts({
      runId: 'r5',
      brandId: 1,
      subjects,
      markdown: '对比来看:\n\n1. 小米 SU7 与 特斯拉 Model 3 各有优势',
    });
    const self = facts.find((f) => f.subjectKey === 'self:xiaomi')!;
    const tesla = facts.find((f) => f.subjectKey === 'comp:tesla')!;
    expect(self.coRanked).toBe(true);
    expect(tesla.coRanked).toBe(true);
    expect(self.rank).toBe(1);
    expect(tesla.rank).toBe(1);
  });

  it('重复实体(A12:小鹏 P7+ / P7+ 725 Max)取最小位次,不重复计位', () => {
    const facts = buildMentionFacts({
      runId: 'r6',
      brandId: 1,
      subjects: [
        { key: 'comp:xpeng', kind: 'competitor', name: '小鹏 P7+', aliases: ['小鹏 P7+ 725 Max'] },
      ],
      markdown: '榜单:\n\n1. 极氪 001\n2. 小鹏 P7+\n3. 智界 S7\n4. 小鹏 P7+ 725 Max',
    });
    const xpeng = facts[0];
    expect(xpeng.mentioned).toBe(true);
    expect(xpeng.rank).toBe(2); // 首次出现位次
  });
});
