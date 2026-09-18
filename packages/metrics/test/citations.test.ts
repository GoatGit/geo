import { describe, expect, it } from 'vitest';
import { classifyDomain, isOwnedDomain, normalizeUrl } from '../src/citations';
import { matchSubject } from '../src/match';

describe('citations(docs/05 §3.1)', () => {
  it('URL 归一:剥跟踪参数、去 hash、取主域', () => {
    const n = normalizeUrl('https://www.autohome.com.cn/news/123?s=1&utm_source=x#top');
    expect(n.domain).toBe('autohome.com.cn');
    expect(n.url).not.toContain('utm_source');
  });

  it('跟踪参数精确剔除:不误删正常参数(video 保留,vd 剔除)', () => {
    const n = normalizeUrl('https://v.qq.com/x?vd=abc&video=keep&front=keep2&from=x');
    expect(n.url).toContain('video=keep');
    expect(n.url).toContain('front=keep2');
    expect(n.url).not.toContain('vd=abc');
    expect(n.url).not.toContain('from=x');
  });

  it('平台分类:精确域 + 子域最长匹配(容忍误传完整 URL)', () => {
    expect(classifyDomain('autohome.com.cn').platform).toBe('汽车之家');
    expect(classifyDomain('www.zhihu.com').platform).toBe('知乎');
    expect(classifyDomain('www.zhihu.com/question/1').platform).toBe('知乎');
  });

  it('平台分类:误传带协议的完整 URL 同样容错(与 isOwnedDomain 同一归一口径)', () => {
    expect(classifyDomain('https://www.zhihu.com/question/1').platform).toBe('知乎');
    expect(classifyDomain('HTTPS://WWW.ZHIHU.COM').platform).toBe('知乎');
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

  it('自有域名判定:domain 参数做与 classifyDomain 相同的归一(协议/路径/大小写)', () => {
    expect(isOwnedDomain('WWW.Xiaomiev.com/', ['xiaomiev.com'])).toBe(true);
    expect(isOwnedDomain('https://www.xiaomiev.com/car/su7', ['xiaomiev.com'])).toBe(true);
    expect(isOwnedDomain('xiaomiev.com', ['https://www.xiaomiev.com'])).toBe(true);
    expect(isOwnedDomain('evil-xiaomiev.com', ['https://xiaomiev.com'])).toBe(false);
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

  it('模糊兜底口径:3 字词低于 FUZZY_MIN_LEN 不做模糊兜底(硬断言)', () => {
    // 「比亞迪」为繁体异体,归一层(小写/全半角)不做繁简映射,且 3 字低于
    // FUZZY_MIN_LEN=4,按现口径不命中;此处以硬断言固化该口径,不再用条件断言掩盖。
    expect(matchSubject('比亞迪', subjects)).toBeNull();
  });

  it('模糊兜底:1 字之差低置信硬断言(fuzzy 不得为 null,进抽检池)', () => {
    const m = matchSubject('综合来看小米su8是一款不错的车', subjects); // '小米su8' ≈ '小米SU7' 距离 1
    expect(m).not.toBeNull();
    expect(m!.method).toBe('fuzzy');
    expect(m!.confidence).toBeLessThan(0.8);
  });

  it('不相关文本返回 null', () => {
    expect(matchSubject('极氪 001', subjects)).toBeNull();
  });
});
