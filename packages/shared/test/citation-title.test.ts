import { describe, expect, it } from 'vitest';
import { sanitizeCitationTitle } from '../src/citation-title';

/** 模拟 CDP latin1/cp1252 转码损坏:UTF-8 字节按 latin1 逐字节读回。 */
function mojibakeOf(s: string): string {
  return Buffer.from(s, 'utf8').toString('latin1');
}

describe('引用标题净化(样板句/裸 URL/mojibake)', () => {
  it('引擎引用区样板锚文本 → null(引用 22 篇资料作为参考 事故回归)', () => {
    expect(sanitizeCitationTitle('引用 22 篇资料作为参考')).toBeNull();
    expect(sanitizeCitationTitle('引用8个来源')).toBeNull();
    expect(sanitizeCitationTitle('查看更多来源')).toBeNull();
    expect(sanitizeCitationTitle('参考资料')).toBeNull();
    // 真实标题不能误伤
    expect(sanitizeCitationTitle('参考消息:2026 经济报道')).not.toBeNull();
  });

  it('裸 URL 锚文本 → null(weibo/toutiao 裸链事故回归)', () => {
    expect(sanitizeCitationTitle('https://weibo.com/7746451627/5344446138024917')).toBeNull();
    expect(sanitizeCitationTitle('www.toutiao.com/article/7650432854186279450')).toBeNull();
  });

  it('cp1252 mojibake 还原为原文(gcmct.com 乱码事故回归)', () => {
    expect(sanitizeCitationTitle(mojibakeOf('相关新闻'))).toBe('相关新闻');
    expect(sanitizeCitationTitle(mojibakeOf('理想汽车口碑盘点:2026 最新报道'))).toBe(
      '理想汽车口碑盘点:2026 最新报道',
    );
    // 混有正常中文 + 高区字符,不是纯 mojibake,修不动 → null
    expect(sanitizeCitationTitle('理想汽车ç»è®¯')).toBeNull();
  });

  it('正常标题原样保留;控制符/空白规整;超长截断', () => {
    expect(sanitizeCitationTitle('理想汽车质量怎么样?车主真实反馈')).toBe(
      '理想汽车质量怎么样?车主真实反馈',
    );
    expect(sanitizeCitationTitle('  理想L9\t试驾\n报告  ')).toBe('理想L9 试驾 报告');
    const long = '很'.repeat(80);
    const out = sanitizeCitationTitle(long);
    expect(out).toBe(`${'很'.repeat(60)}…`);
  });

  it('空值与空串 → null', () => {
    expect(sanitizeCitationTitle(null)).toBeNull();
    expect(sanitizeCitationTitle('')).toBeNull();
    expect(sanitizeCitationTitle('   ')).toBeNull();
  });
});
