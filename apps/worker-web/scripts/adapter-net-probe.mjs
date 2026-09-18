/* 网络监听探针:ask 期间记录所有 XHR/fetch 响应,找出携带搜索来源的 API。
 * 用法: node adapter-net-probe.mjs <cdp> <engine> [question] */
import { chromium } from 'playwright-core';
import pg from 'pg';
import { DomWebAdapter } from '@geo/engine-adapters';
import { writeFileSync } from 'node:fs';

const cdp = process.argv[2];
const engine = process.argv[3] || 'yuanbao';
const question = process.argv[4] || '2026年20万左右预算买什么新能源SUV好?请结合网络资料推荐具体车型';

const pdb = new pg.Client({ connectionString: 'postgres://geo:bekvom-weBvyx-6nogri@geopub.pg.rds.aliyuncs.com:15432/geo', ssl: false });
await pdb.connect();
const pr = await pdb.query(
  "SELECT id, cookies FROM account_profiles WHERE engine=$1 AND status='available' AND cookies IS NOT NULL ORDER BY id LIMIT 1",
  [engine],
);
await pdb.end();
const profile = pr.rows[0];
console.log(`[probe] engine=${engine} profile=${profile.id}`);

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] || (await browser.newContext());
await ctx.addCookies(profile.cookies);
const page = ctx.pages()[0] || (await ctx.newPage());

// 网络监听:记录 JSON 响应(文本型),存 URL+body 摘要
const captured = [];
const onResp = (resp) => {
  const url = resp.url();
  const ct = resp.headers()['content-type'] || '';
  if (!/json|text\/plain/i.test(ct)) return;
  if (/\.(js|css|png|jpg|jpeg|gif|woff2?|svg|ico)(\?|$)/i.test(url)) return;
  captured.push({ url: url.slice(0, 250), ct, size: 0, body: '' });
  const slot = captured[captured.length - 1];
  resp.text().then((t) => {
    slot.size = t.length;
    slot.body = t.length > 200_000 ? t.slice(0, 200_000) : t;
  }).catch(() => {});
};
page.on('response', onResp);

const adapter = new DomWebAdapter(engine);
const t0 = Date.now();
const result = await adapter.ask({ page, profileKey: `probe-${profile.id}` }, question, { timeoutMs: 150_000 });
console.log(`[probe] ask done in ${Math.round((Date.now() - t0) / 1000)}s status=${result.status} citations=${result.citations.length}`);
await page.waitForTimeout(3000);
page.off('response', onResp);

console.log(`captured ${captured.length} JSON responses`);
writeFileSync(`/tmp/net-${engine}.json`, JSON.stringify(captured, null, 1));
// 概要:每个响应的 URL + 是否含外部 http 链接
for (const c of captured) {
  const ext = [...new Set((c.body.match(/https?:\/\/(?!www\.doubao|yuanbao|tencent)[^"'\s\\]+/g) || []))];
  const extFiltered = ext.filter((u) => !/\.(js|css|png|jpg|jpeg|gif|woff2?|svg|ico|webp)(\?|$)/i.test(u));
  if (c.size > 0) console.log(`  ${c.url.slice(0, 110)} | size=${c.size} | extUrls=${extFiltered.length}`);
}
await browser.close();
