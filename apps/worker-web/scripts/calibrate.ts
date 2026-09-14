/**
 * 站点 DOM 校准工具(docs/04 §7 失败模式手册:页面改版后的选择器校准)。
 * 用法:BROWSER_MODE=local tsx scripts/calibrate.ts <engine> [profileId]
 * 需该账号档案已人工登录(管理后台「账号池」发起)。输出:
 * 最终 URL / 登录检测 / 输入框命中 / 提交后 URL 与文本增长 / 回答容器候选命中 / data-testid 清单。
 * 校准结果回填 packages/engine-adapters/src/web/sites.ts 并升 schemaVersion。
 */
import { LocalSessionBroker } from '@geo/browser-session';
import { DomWebAdapter, checkLogin, hasVisibleInput, siteConfigOf } from '@geo/engine-adapters';
import type { EngineId } from '@geo/shared';
import { createDb } from '@geo/db';

const ANSWER_CANDIDATES = [
  '.ds-markdown',
  '[class*="markdown-body"]',
  '[class*="markdown"]',
  '[class*="answer"]',
  '[class*="receive"]',
  '[class*="response"]',
  '[data-testid="receive_message"]',
  '[class*="message-content"]',
];

async function main() {
  const engine = (process.argv[2] ?? 'doubao') as EngineId;
  const profileId = Number(process.argv[3] ?? 21);
  const site = siteConfigOf(engine);
  const { pool } = createDb(process.env.DATABASE_URL);
  const broker = new LocalSessionBroker({
    profileRoot: process.env.LOCAL_BROWSER_PROFILE_DIR ?? './infra/local-data/browser-profiles',
    channel: process.env.LOCAL_BROWSER_CHANNEL ?? 'chrome',
    headless: (process.env.LOCAL_BROWSER_HEADED ?? '') !== '1',
    idleCloseMs: 0,
    maxConcurrent: 4,
  });

  console.log(`===== 校准 ${engine}(${site.displayName})profile:${profileId} =====`);
  const session = await broker.acquire({
    profileKey: `profile:${profileId}`,
    fingerprint: { viewport: '1366x850' },
    purpose: 'collect',
  });
  try {
    const page = session.page;
    const adapter = new DomWebAdapter(engine);
    const r = await adapter.ask(
      { mode: 'browser', page, fingerprint: {}, profileKey: `profile:${profileId}` },
      '20万左右值得买的纯电轿车有哪些?',
      { timeoutMs: Number(process.env.ASK_TIMEOUT_MS ?? 90_000) },
    );
    console.log('ask:', r.status, JSON.stringify(r.engineMeta));
    console.log('answer head:', r.answerText.replace(/\s+/g, ' ').slice(0, 160));
    console.log('citations:', r.citations.length, JSON.stringify(r.citations.slice(0, 3)));
    if (r.status === 'failed') {
      // ask 失败时的现场诊断
      await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      const login = await checkLogin(page, site);
      const input = await hasVisibleInput(page, site);
      console.log('login:', JSON.stringify(login), '| input visible:', input, '| url:', page.url());
      for (const sel of ANSWER_CANDIDATES) {
        const n = await page.locator(sel).count().catch(() => -1);
        if (n > 0) console.log('answer-candidate hit:', sel, `x${n}`);
      }
      const testids = await page.evaluate(() => {
        const out = new Set<string>();
        for (const el of document.querySelectorAll('[data-testid]')) {
          out.add(el.getAttribute('data-testid')!);
          if (out.size > 25) break;
        }
        return [...out];
      });
      console.log('data-testids:', JSON.stringify(testids));
    }
  } finally {
    await session.release();
    await broker.destroyAll();
    await pool.end();
  }
}
main().catch((e) => {
  console.error('校准失败:', e.message.split('\n')[0]);
  process.exit(1);
});
