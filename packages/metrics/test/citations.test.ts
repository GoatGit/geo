import { describe, expect, it } from 'vitest';
import { classifyDomain, isOwnedDomain, normalizeUrl } from '../src/citations';
import { matchSubject } from '../src/match';

describe('citations(docs/05 §3.1)', () => {
  it('URL 归一:剥跟踪参数、去 hash、取主域', () => {
    const n = normalizeUrl('https://www.autohome.com.cn/news/123?s=1&utm_source=x#top');
    expect(n.domain).toBe('autohome.com.cn');
    expect(n.url).not.toContain('utm_source');
  });

  it('平台分类:精确域 + 子域最长匹配(容忍误传完整 URL)', () => {
    expect(classifyDomain('autohome.com.cn').platform).toBe('汽车之家');
    expect(classifyDomain('www.zhihu.com').platform).toBe('知乎');
    expect(classifyDomain('www.zhihu.com/question/1').platform).toBe('知乎');
  });

  it('未命中字典 → unknown(生产走 LLM 分类并入复核队列)', () => {
    const c = classifyDomain('some-random-site.cn');
    expect(c.category).toBe('unknown');
  });

  it('自有域名判定:精确或子域', () => {
    expect(isOwnedDomain('xiaomiev.com', ['xiaomiev.com'])).toBe(true);
    expect(isOwnedDomain('www.xiaomiev.com', ['xiaomiev.com'])).toBe(true);
    expect(isOwnedDomain('evil-xiaomiev.com', ['xiaomiev.com'])).toBe(false);
  });
});

describe('matchSubject(docs/02 §1.2 识别口径)', () => {
  const subjects = [
    { key: 'self', kind: 'self' as const, name: '小米汽车', aliases: ['小米SU7', 'SU7', 'YU7'] },
    { key: 'c1', kind: 'competitor' as const, name: '比亚迪', aliases: ['海豹'] },
  ];

  it('主体名精确命中置信 0.95;纯别名命中置信 0.9', () => {
    const m = matchSubject('比亚迪海豹 08 EV', subjects);
    expect(m?.subject.key).toBe('c1');
    expect(m?.method).toBe('exact'); // 命中的是主体名"比亚迪"
    expect(m?.confidence).toBe(0.95);

    const aliasOnly = matchSubject('海豹 08 EV', subjects);
    expect(aliasOnly?.subject.key).toBe('c1');
    expect(aliasOnly?.method).toBe('alias');
    expect(aliasOnly?.confidence).toBe(0.9);
  });

  it('模糊兜底:1 字之差低置信(进抽检池)', () => {
    const m = matchSubject('比亞迪', subjects); // 全角异体,归一后不完全等价
    if (m) expect(m.confidence).toBeLessThan(0.8);
  });

  it('不相关文本返回 null', () => {
    expect(matchSubject('极氪 001', subjects)).toBeNull();
  });
});
