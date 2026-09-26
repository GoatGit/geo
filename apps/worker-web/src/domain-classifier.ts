import { sql } from 'drizzle-orm';
import type { Db } from '@geo/db';
import { loadPlatformSettings } from '@geo/db';
import { chatCompletion } from '@geo/insight-agent';
import { DEFAULT_DOMAIN_DICT, type PlatformClassification } from '@geo/metrics';

/**
 * 域名 LLM 分类器(docs/14 §32 对策):引用源出现 unknown 类别时,用 LLM 识别
 * 一次并写入 platform_domain_dict——之后同域名永远走字典,不再调 LLM。
 * 采集抽取(extraction)读「代码默认 + DB 字典」合并缓存;本模块每轮先刷新缓存。
 */

const KNOWN_CATEGORIES = [
  '门户/资讯', '门户/财经', '资讯', '资讯/科技', '资讯/推荐', '资讯/百科',
  '垂媒', 'UGC/问答', 'UGC/社区', 'UGC/社交', 'UGC/视频', 'UGC/短视频',
  '百科', '技术社区', '官网',
] as const;

let dictCache: Record<string, PlatformClassification> | null = null;

/** 采集抽取用的合并字典:代码默认 + DB 字典(LLM 识别产物在列)。 */
export function mergedDomainDict(): Record<string, PlatformClassification> {
  return dictCache ? { ...DEFAULT_DOMAIN_DICT, ...dictCache } : DEFAULT_DOMAIN_DICT;
}

/** 刷新字典缓存(worker 周期调用;进程级缓存,避免每次抽取查库)。 */
export async function refreshDomainDict(db: Db): Promise<void> {
  try {
    const res = await db.execute(sql`select domain, platform, category from platform_domain_dict`);
    const rows = (res as unknown as { rows: Array<{ domain: string; platform: string; category: string }> }).rows;
    dictCache = Object.fromEntries(
      rows.filter((r) => r.domain && r.platform && r.category).map((r) => [
        r.domain.toLowerCase(),
        { platform: r.platform, category: r.category } satisfies PlatformClassification,
      ]),
    );
  } catch {
    // 字典读失败:沿用代码默认
  }
}

/** 子域前缀:注册字典时归一到根域(m.12365auto.com → 12365auto.com),
 *  classifyDomain 的后缀匹配天然覆盖其余子域;避免"字典里是子域、裸域行配不上"。
 *  仅当总标签数 ≥3 时剥离(com.cn 双段后缀不算裸两段)。 */
const SUBDOMAIN_PREFIXES = new Set(['m', 'wap', 'www', '3g', 'mobile', 'news', 'g', 'post', 'page', 'best', 'so', 'v', 'auto', 'car', 'finance', 'tech', 'smart']);
function canonicalRoot(host: string): string {
  const labels = host.split('.');
  if (labels.length >= 3 && SUBDOMAIN_PREFIXES.has(labels[0]!)) return labels.slice(1).join('.');
  return host;
}

const triedDomains = new Set<string>();

/**
 * 识别 unknown 域名并入库+回填:取引用次数最多的未识别域名(不在字典、本进程
 * 未试过),逐个 LLM 分类 → 写 platform_domain_dict(source='llm')→ 回填该域名
 * (含子域)全部 unknown 行的类别。返回新增字典条数。
 */
export async function classifyUnknownDomains(db: Db, limit = 8): Promise<number> {
  await refreshDomainDict(db);
  const dict = mergedDomainDict();

  const res = await db.execute(sql`
    select domain, count(*)::int as hits, max(title) as sample_title, min(raw_url) as sample_url
    from citation_facts
    where platform_category = 'unknown'
    group by domain
    order by hits desc
    limit ${limit * 4}
  `);
  const rows = ((res as unknown as { rows: Array<{ domain: string; hits: number; sample_title: string | null; sample_url: string }> }).rows)
    .filter((r) => {
      const host = r.domain.toLowerCase().replace(/^www\./, '');
      return !dict[host] && !triedDomains.has(host);
    })
    .slice(0, limit);
  if (rows.length === 0) return 0;

  const cfg = (await loadPlatformSettings(db)).insightAgent;
  if (!cfg.enabled || cfg.mode === 'rules' || !cfg.endpoint || !cfg.apiKey || !cfg.model) return 0;

  let added = 0;
  for (const r of rows) {
    const host = canonicalRoot(r.domain.toLowerCase());
    triedDomains.add(host);
    try {
      const system =
        '你是中文网站分类器。给定域名与内容样例,只输出一个 JSON 对象,不要多余文字。' +
        `schema: {"platform":"平台中文名(2-6字,如 知乎/汽车之家/什么值得买)","category":"类别"}。` +
        `category 必须从这些里选一个:${KNOWN_CATEGORIES.join(' / ')}。不确定就选"资讯"。`;
      const user = JSON.stringify({ 域名: host, 样例标题: r.sample_title ?? '', 样例链接: r.sample_url });
      const raw = await chatCompletion(
        { protocol: cfg.protocol as 'openai' | 'anthropic', endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 30_000 },
        { system, user, maxTokens: 150 },
      );
      const m = raw.text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]) as { platform?: string; category?: string };
      const platform = String(parsed.platform ?? '').trim().slice(0, 12);
      const category = (KNOWN_CATEGORIES as readonly string[]).includes(String(parsed.category))
        ? String(parsed.category)
        : '资讯';
      if (platform.length < 2) continue;

      await db.execute(sql`
        insert into platform_domain_dict (domain, platform, category, source, confirmed)
        values (${host}, ${platform}, ${category}, 'ai', false)
        on conflict (domain) do nothing
      `);
      dictCache = { ...mergedDomainDict(), [host]: { platform, category } };
      // 回填存量(含子域:m.x / post.x 归并为同一平台)
      await db.execute(sql`
        update citation_facts set platform_category = ${category}
        where platform_category = 'unknown'
          and (domain = ${host} or domain like ${'%.' + host})
      `);
      // 子域污染兜底:同类子域(m.x/g.x)统一归并
      await db.execute(sql`
        update citation_facts set platform_category = ${category}
        where platform_category = 'unknown'
          and domain like ${'%.%.' + host}
          and split_part(domain, '.', 1) = any(${sql`array['m','wap','g','post','page','best','news','mobile']`}::text[])
      `);
      console.log(`[domain-dict] LLM 识别 ${host} → ${platform}/${category}(回填引用行)`);
      added++;
    } catch (err) {
      console.warn(`[domain-dict] ${host} 识别失败:`, (err as Error).message.slice(0, 80));
    }
  }
  return added;
}
