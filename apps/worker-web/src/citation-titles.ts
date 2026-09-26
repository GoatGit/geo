import { sql } from 'drizzle-orm';
import type { Db } from '@geo/db';

/**
 * 引用标题回填(docs/14 §33 延伸):引用源的 title 采集天然不完整——
 * DeepSeek 的引用锚点是纯角标(DOM 无文本),元宝载荷里部分来源无 title 字段。
 * 这里对 title 为空的 citation_facts 异步抓取页面 <title> 补齐(通用,不挑引擎)。
 * worker 每 10 分钟跑一批;失败的 URL 进程内记跳过,避免反复重试死链。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

/** 提取 <title> 并做常见 HTML 实体解码;取不到返回 null。 */
export function extractHtmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m) return null;
  const t = m[1]!
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 4 && t.length <= 120 ? t : null;
}

/** 抓单条 URL 的页面标题(8s 超时,最多读 96KB);失败 null。
 *  编码:国内站点常见 GBK/GB2312(红网实测),按 content-type 头或 meta 声明
 *  选择解码器,否则 UTF-8 解出乱码入库。 */
async function fetchTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const buf = await res.arrayBuffer().then((b) => b.slice(0, 96 * 1024));
    const bytes = new Uint8Array(buf);
    // 编码判定:header charset → meta charset(ascii 预读)→ 默认 utf-8
    let charset = /charset=([\w-]+)/i.exec(ct)?.[1]?.toLowerCase() ?? '';
    if (!charset) {
      const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, 2048));
      charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? '';
    }
    const decoder =
      charset.startsWith('gb') || charset === 'gb2312' || charset === 'gbk'
        ? new TextDecoder('gbk', { fatal: false })
        : new TextDecoder('utf-8', { fatal: false });
    return extractHtmlTitle(decoder.decode(bytes));
  } catch {
    return null;
  }
}

const failedUrls = new Set<string>();

/** 回填一批(默认 40 条,8 并发);返回成功补齐数。 */
export async function backfillCitationTitles(db: Db, limit = 40): Promise<number> {
  const res = await db.execute(sql`
    select id, raw_url from citation_facts
    where (title is null or title = '')
    order by random()
    limit ${limit * 2}
  `);
  const rows = (res as unknown as { rows: Array<{ id: string; raw_url: string }> }).rows
    .filter((r) => !failedUrls.has(r.raw_url))
    .slice(0, limit);
  if (rows.length === 0) return 0;

  let fixed = 0;
  const CONCURRENCY = 8;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        const title = await fetchTitle(r.raw_url);
        if (title) {
          await db.execute(
            sql`update citation_facts set title = ${title} where id = ${Number(r.id)} and (title is null or title = '')`,
          );
          fixed++;
        } else {
          failedUrls.add(r.raw_url); // 死链/无 title:本进程内不再重试
        }
      }),
    );
  }
  return fixed;
}
