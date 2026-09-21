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
    // 生产库实存形态:cp1252 全码点(U+203A/U+2014 等高区映射字符,Buffer latin1 模拟不出)
    const prodForm = String.fromCodePoint(
      0x00e7, 0x203a, 0x00b8, 0x00e5, 0x2026, 0x00b3, 0x00e6, 0x2013, 0x00b0, 0x00e9, 0x2014, 0x00bb,
    );
    expect(sanitizeCitationTitle(prodForm)).toBe('相关新闻');
    // 混有正常中文 + 高区字符,不是纯 mojibake,修不动 → null
    expect(sanitizeCitationTitle('理想汽车ç»è®¯')).toBeNull();
  });

  it('中文排版字符不误判为乱码:——/……/"" 标题原样保留', () => {
    const legit = '理想L6 Pro值得购买吗——2026 年有什么值得关注的?';
    expect(sanitizeCitationTitle(legit)).toBe(legit);
    const quoted = '新能源车"价格战"……谁是赢家?';
    expect(sanitizeCitationTitle(quoted)).toBe(quoted);
    // 纯拉丁小语种标题修复失败时保留原文,不误删
    expect(sanitizeCitationTitle('Curaçao tourism report')).toBe('Curaçao tourism report');
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
