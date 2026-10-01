import { describe, expect, it } from 'vitest';
import { priorityOf, REPUTATION_QUEUE, REPORTS_QUEUE, COLLECT_QUEUE } from '../src/queue';

describe('queue 配置(docs/04 §5 优先级队列)', () => {
  it('BullMQ 队列名不允许含冒号', () => {
    for (const name of [COLLECT_QUEUE, REPUTATION_QUEUE, REPORTS_QUEUE]) {
      expect(name).not.toContain(':');
    }
  });

  it('档位优先级:数值越小越优先 —— 定制 < 专业 < 标准 < 入门 < 免费(BullMQ 语义)', () => {
    // BullMQ priority: 数值小的先被调度。付费越高档数值必须越小。
    expect(priorityOf('custom')).toBeLessThan(priorityOf('pro'));
    expect(priorityOf('pro')).toBeLessThan(priorityOf('standard'));
    expect(priorityOf('standard')).toBeLessThan(priorityOf('starter'));
    expect(priorityOf('starter')).toBeLessThan(priorityOf('free'));
    // 未知档位按免费兜底(数值最大 = 最不优先),不得反向抢占付费档
    expect(priorityOf('unknown-plan')).toBe(priorityOf('free'));
  });
});
