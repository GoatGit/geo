import { describe, expect, it } from 'vitest';
import { priorityOf, REPUTATION_QUEUE, REPORTS_QUEUE, COLLECT_QUEUE } from '../src/queue';

describe('queue 配置(docs/04 §5 优先级队列)', () => {
  it('BullMQ 队列名不允许含冒号', () => {
    for (const name of [COLLECT_QUEUE, REPUTATION_QUEUE, REPORTS_QUEUE]) {
      expect(name).not.toContain(':');
    }
  });

  it('档位优先级:免费 < 入门 < 标准 < 专业 < 定制(快速体检加急另计)', () => {
    const order = ['free', 'starter', 'standard', 'pro', 'custom'].map(priorityOf);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });
});
