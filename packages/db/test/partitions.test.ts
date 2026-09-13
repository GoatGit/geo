import { describe, expect, it } from 'vitest';
import { partitionStatements } from '../src/partitions';

describe('partitionStatements(分区 DDL 生成,docs/05 §5)', () => {
  const now = new Date('2026-09-14T08:00:00Z');

  it('为 4 张分区表生成当月+未来 2 个月分区与 DEFAULT 兜底', () => {
    const stmts = partitionStatements(now, 2);
    expect(stmts).toHaveLength(4 * 3 + 4);
    expect(stmts.filter((s) => s.includes('query_runs_2026_09 '))).toHaveLength(1);
    expect(stmts.filter((s) => s.includes('query_runs_2026_11 '))).toHaveLength(1);
    expect(stmts.every((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(stmts.some((s) => s.endsWith('DEFAULT'))).toBe(true);
  });

  it('range 边界为自然月(UTC)', () => {
    const stmts = partitionStatements(now, 0);
    const sep = stmts.find((s) => s.includes('query_runs_2026_09 '))!;
    expect(sep).toContain("FROM ('2026-09-01T00:00:00.000Z') TO ('2026-10-01T00:00:00.000Z')");
  });

  it('跨年滚动', () => {
    const stmts = partitionStatements(new Date('2026-12-15T00:00:00Z'), 1);
    expect(stmts.some((s) => s.includes('query_runs_2027_01 '))).toBe(true);
  });
});
