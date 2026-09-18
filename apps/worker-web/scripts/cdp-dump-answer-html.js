// 豆包/元宝引用卡片结构深挖:dump 最后回答节点内含"参考/来源/搜索"语义的 HTML 片段。
// 用法: node cdp-dump-answer-html.js <cdp> <engine> <question>
const { chromium } = require('playwright-core');
const pg = require('pg');

const cdp = process.argv[2];
const engine = process.argv[3] || 'doubao';
const question = process.argv[4] || '2026年20万预算买什么新能源SUV好?家用为主,讲讲各车型优缺点';
const CHAT_URLS = { doubao: 'https://www.doubao.com/chat/', yuanbao: 'https://yuanbao.tencent.com/chat', qwen: 'https://www.qianwen.com/' };

(async () => {
  const pdb = new pg.Client({ connectionString: (process.env.DATABASE_URL || 'postgres://localhost/geo'), ssl: false });
  await pdb.connect();
  const pr = await pdb.query(
    "SELECT id, cookies FROM account_profiles WHERE engine=$1 AND status='available' AND cookies IS NOT NULL ORDER BY id LIMIT 1",
    [engine],
  );
  await pdb.end();
  if (pr.rows.length === 0) { console.error('NO_COOKIES for', engine); process.exit(1); }
  const profile = pr.rows[0];
  console.log(`[probe] engine=${engine} profile=${profile.id} cookies=${profile.cookies.length}`);

  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  await ctx.addCookies(profile.cookies);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(CHAT_URLS[engine] || CHAT_URLS.doubao, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(9000);
  for (const sel of ['button:has-text("我知道了")', 'button:has-text("同意")', 'button:has-text("确定")']) {
    await page.locator(sel).first().click({ timeout: 800 }).catch(() => {});
  }
  const input = page.locator('[contenteditable="true"], textarea').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  try { await input.click(); await page.keyboard.insertText(question); } catch { await input.fill(question); }
  await page.waitForTimeout(1500);
  for (const sel of ['button[class*="highlight"]', 'button:has-text("发送")', 'button[type="submit"]', '#sendBtn', 'div[class*="send"][role="button"]']) {
    if (await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) { await page.locator(sel).first().click().catch(() => {}); break; }
  }
  console.log('[probe] submitted');
  let prev = ''; let stable = 0;
  for (let i = 0; i < 84; i++) {
    await page.waitForTimeout(5000);
    let t = 0;
    try { t = await page.evaluate(() => document.body.innerText.length); } catch {}
    // 回答一般 >1500 字符;未达到阈值不进入稳定计数,避免把提问页误判为完成
    if (t === prev && t > 1500) { stable++; if (stable >= 4) break; } else stable = 0;
    prev = t;
    if (i % 6 === 5) console.log(`  [wait] t=${i} bodyLen=${t}`);
  }
  console.log('[probe] stable at', prev, 'url:', page.url());
  await page.waitForTimeout(5000);

  const r = await page.evaluate(() => {
    const out = {};
    // 找含"参考/来源/搜索 N 篇"语义的最小元素,向上取容器,dump 前两级 HTML
    const kw = /参考\s*\d+\s*(篇|个资料|条)|来源|搜索到|篇资料/;
    const hits = [];
    for (const el of document.querySelectorAll('div,span,p')) {
      const t = (el.innerText || '').trim();
      if (t && t.length < 80 && kw.test(t)) hits.push(el);
    }
    out.keywordHits = hits.slice(0, 5).map((el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 80),
      text: (el.innerText || '').slice(0, 60),
      parentCls: (el.parentElement?.className || '').toString().slice(0, 80),
      grandCls: (el.parentElement?.parentElement?.className || '').toString().slice(0, 80),
    }));

    // 最后一个 message 容器内的完整 HTML 结构(去文本,只看骨架)
    const msgs = Array.from(document.querySelectorAll('div[class*="message"]'));
    const last = msgs[msgs.length - 1];
    if (last) {
      const skeleton = (root, depth, maxDepth) => {
        if (depth > maxDepth) return '';
        return Array.from(root.children)
          .slice(0, 12)
          .map((c) => {
            const cls = (c.className || '').toString().slice(0, 70).replace(/\s+/g, '.');
            const dt = c.getAttribute('data-testid') ? ` testid=${c.getAttribute('data-testid')}` : '';
            const nlinks = c.querySelectorAll('a[href]').length;
            const inner = (c.innerText || '').replace(/\s+/g, ' ').slice(0, 40);
            return `${'  '.repeat(depth)}<${c.tagName.toLowerCase()}${dt} class="${cls}" links=${nlinks}> ${inner}\n` + skeleton(c, depth + 1, maxDepth);
          })
          .join('');
      };
      out.lastMessageSkeleton = skeleton(last, 0, 4).slice(0, 6000);
      out.lastMessageText = (last.innerText || '').slice(0, 600);
    }
    return out;
  });

  console.log('== keywordHits ==');
  for (const h of r.keywordHits) console.log(' ', JSON.stringify(h, null, 0));
  console.log('== lastMessageText ==');
  console.log(r.lastMessageText);
  console.log('== lastMessageSkeleton ==');
  console.log(r.lastMessageSkeleton);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message.slice(0, 150)); process.exit(1); });
