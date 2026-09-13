import { describe, expect, it } from 'vitest';
import { toSubjects } from '../src/extraction';

describe('toSubjects(docs/05 §2 识别口径 → 匹配主体)', () => {
  it('本品永远参与匹配(即使未确认)', () => {
    const subjects = toSubjects(
      [{ id: 2, kind: 'competitor', name: '比亚迪', aliases: ['海豹'] }],
      '小米汽车',
    );
    expect(subjects.some((s) => s.kind === 'self' && s.name === '小米汽车')).toBe(true);
    expect(subjects.some((s) => s.key === 'competitor:2')).toBe(true);
  });

  it('已确认本品不重复注入', () => {
    const subjects = toSubjects(
      [{ id: 1, kind: 'self', name: '小米汽车', aliases: ['SU7'] }],
      '小米汽车',
    );
    expect(subjects.filter((s) => s.kind === 'self')).toHaveLength(1);
  });
});
