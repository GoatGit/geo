export interface NormalizedUrl {
  /** 去参后的 URL(跟踪参数剥离) */
  url: string;
  domain: string;
}

/**
 * 跟踪参数剔除口径:
 * - 无下划线的短参数(from/fr/spm/vd 等)按「参数名精确相等」剔除——前缀匹配会误伤正常参数
 *   (旧口径 /^(...|vd)/ 会删掉 video、/^fr/ 会删掉 front 等);
 * - utm_/share_/vd_ 等自带下划线的命名空间按前缀剔除,覆盖变体且无误伤面。
 */
const TRACKING_PARAM_EXACT = new Set(['from', 'fr', 'spm', 'vd', 'sh_h', 'igshid', 'si']);
const TRACKING_PARAM_PREFIX = /^(utm_|share_|vd_)/i;

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_EXACT.has(key.toLowerCase()) || TRACKING_PARAM_PREFIX.test(key);
}

/** 引用 URL 归一(docs/05 §3.1):去协议差异、剥跟踪参数、取主域。 */
export function normalizeUrl(raw: string): NormalizedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    const guess = raw.replace(/^https?:\/\//, '').split('/')[0];
    return { url: raw, domain: guess.replace(/^www\./, '') };
  }
  const keep: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => {
    if (!isTrackingParam(k)) keep.push([k, v]);
  });
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  u.hash = '';
  return { url: u.toString(), domain: u.hostname.replace(/^www\./, '') };
}

export interface PlatformClassification {
  platform: string;
  category: string;
}

export const DEFAULT_DOMAIN_DICT: Record<string, PlatformClassification> = {
  'sina.com.cn': { platform: '新浪', category: '门户/资讯' },
  'sina.com': { platform: '新浪', category: '门户/资讯' },
  'sohu.com': { platform: '搜狐', category: '门户/资讯' },
  '163.com': { platform: '网易', category: '门户/资讯' },
  'qq.com': { platform: '腾讯', category: '门户/资讯' },
  'toutiao.com': { platform: '今日头条', category: '资讯/推荐' },
  'baidu.com': { platform: '百家号/百度', category: '资讯/百科' },
  'baijiahao.baidu.com': { platform: '百家号', category: '资讯' },
  'zhihu.com': { platform: '知乎', category: 'UGC/问答' },
  'douyin.com': { platform: '抖音', category: 'UGC/短视频' },
  'bilibili.com': { platform: 'B站', category: 'UGC/视频' },
  'autohome.com.cn': { platform: '汽车之家', category: '垂媒' },
  'dongchedi.com': { platform: '懂车帝', category: '垂媒' },
  'yiche.com': { platform: '易车', category: '垂媒' },
  'csdn.net': { platform: 'CSDN', category: '技术社区' },
  'xiaomi.com': { platform: '小米', category: '官网' },
  'xiaomiev.com': { platform: '小米汽车', category: '官网' },
};

/**
 * 平台分类(docs/05 §3.1):字典优先(子域匹配最长前缀),未命中返回 unknown
 * ——生产环境走 LLM 分类并自动入字典(人工复核队列)。
 */
export function classifyDomain(
  domain: string,
  dict: Record<string, PlatformClassification> = DEFAULT_DOMAIN_DICT,
): PlatformClassification {
  // 容错:允许误传完整 URL(含协议/路径/大小写/www),统一归一为裸 host
  const host = normalizeDomainInput(domain);
  if (dict[host]) return dict[host];
  const suffixMatch = Object.keys(dict)
    .filter((d) => host.endsWith(`.${d}`))
    .sort((a, b) => b.length - a.length)[0];
  if (suffixMatch) return dict[suffixMatch];
  return { platform: host, category: 'unknown' };
}

/** 域名归一:去空白、小写、剥协议、取 host、剥 www(与 classifyDomain 同一口径)。 */
function normalizeDomainInput(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/^www\./, '');
}

/** 自有域名判定:精确或子域归属;双方都做协议/www/路径/大小写归一(docs/05 §3.1 是否自有域名)。 */
export function isOwnedDomain(domain: string, ownedDomains: string[]): boolean {
  const host = normalizeDomainInput(domain);
  return ownedDomains.some((o) => {
    const oo = normalizeDomainInput(o);
    return host === oo || host.endsWith(`.${oo}`);
  });
}
