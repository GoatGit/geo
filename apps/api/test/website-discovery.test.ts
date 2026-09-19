import { describe, expect, it } from 'vitest';
import { normalizeWebsiteInput, sameHostFamily } from '../src/insights/website-discovery';

describe('官网域名归一(品牌资产·官网自动发现)', () => {
  it('补协议、去 www、去路径与参数、小写化', () => {
    expect(normalizeWebsiteInput('www.Lixiang.com/a?b=1')).toBe('https://lixiang.com');
    expect(normalizeWebsiteInput('https://WWW.NIO.COM')).toBe('https://nio.com');
    expect(normalizeWebsiteInput('  lixiang.com  ')).toBe('https://lixiang.com');
  });

  it('非法输入返回 null', () => {
    expect(normalizeWebsiteInput('')).toBeNull();
    expect(normalizeWebsiteInput('not a url')).toBeNull();
    expect(normalizeWebsiteInput('https://localhost')).toBeNull();
  });
});

describe('域名族等价', () => {
  it('apex 与 www 同族,跨域不同族', () => {
    expect(sameHostFamily('lixiang.com', 'www.lixiang.com')).toBe(true);
    expect(sameHostFamily('www.lixiang.com', 'lixiang.com')).toBe(true);
    expect(sameHostFamily('lixiang.com', 'nio.com')).toBe(false);
  });
});
