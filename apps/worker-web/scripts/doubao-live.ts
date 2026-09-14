/* 豆包会话连续性实验(docs/07 §13 PoC):
 * 有头打开 profile → 等真人扫码(不关浏览器)→ 同一会话内连续提问两轮 → 抽取回答。
 * 目的:判定豆包登出风控的触发点是"重开浏览器"还是"提交行为本身"。 */
import { LocalSessionBroker } from '@geo/browser-session';
import { checkLogin, hasVisibleInput, siteConfigOf } from '@geo/engine-adapters';
import type { Page } from 'playwright-core';

const ANSWER_CANDIDATES = [
  '[data-testid="receive_message"]',
  'div[class*="answer"]',
  'div[class*="markdown-body"]',
  '[class*="markdown"]',
  '[class*="receive"]',
];

async function askInSession(page: Page, question: string): Promise<{ ok: boolean; text: string }> {
  const input = page.locator('[contenteditable="true"]').first();
  await input.click({ timeout: 5_000 });
  await input.fill('', { timeout: 3_000 }).catch(() => undefined);
  await page.keyboard.insertText(question);
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  const cleared = await input.innerText({ timeout: 1_000 }).catch(() => '');
  console.log(`  [ask] 提交${cleared.trim() ? '未确认(输入未清空)' : '成功(输入已清空)'}`);

  // 完成判定:停止控件消失 + 文本稳定
  let lastText = '';
  let stable = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2_000);
    const generating = await page
      .locator('[data-testid="stop_button"], button:has-text("停止")')
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (generating) continue;
    let best = '';
    for (const sel of ANSWER_CANDIDATES) {
      const nodes = page.locator(sel);
      const count = await nodes.count().catch(() => 0);
      for (let k = Math.max(0, count - 6); k < count; k++) {
        const t = await nodes.nth(k).innerText({ timeout: 800 }).catch(() => '');
        if (t.trim().length > best.length) best = t.trim();
      }
    }
    if (best && best === lastText) {
      stable += 1;
      if (stable >= 2) return { ok: best.length > 30, text: best };
    } else {
      stable = 0;
      lastText = best || lastText;
    }
  }
  return { ok: lastText.length > 30, text: lastText };
}

async function main() {
  const site = siteConfigOf('doubao');
  const broker = new LocalSessionBroker({
    profileRoot: '/Users/yanghuaiyuan/AI/geo/infra/local-data/browser-profiles',
    channel: 'chrome',
    headless: false, // 必须:有头规避 headless 检测
    idleCloseMs: 0,
    maxConcurrent: 4,
  });
  const session = await broker.acquire({ profileKey: 'profile:21', fingerprint: { viewport: '1366x850' }, purpose: 'login' });
  try {
    const page = session.page;
    await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    console.log('[live] 浏览器已打开,请在窗口内完成豆包登录…');
    let logged = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5_000);
      const { loggedIn } = await checkLogin(page, site);
      if (loggedIn !== false && (await hasVisibleInput(page, site))) {
        logged = true;
        break;
      }
      if (i % 6 === 5) console.log(`[live] 等待中…(${(i + 1) * 5}s)`);
    }
    if (!logged) {
      console.log('[live] 登录等待超时');
      process.exit(2);
    }
    console.log('[live] 检测到登录成功,同一会话内立即连续提问…');

    const r1 = await askInSession(page, '20万左右值得买的纯电轿车有哪些?');
    console.log(`[live] 第1问: ${r1.ok ? 'ANSWERED' : 'NO-ANSWER'}(${r1.text.length} chars) ${r1.text.replace(/\s+/g, ' ').slice(0, 100)}`);

    const r2 = await askInSession(page, '那插电混动呢?简单说说推荐。');
    console.log(`[live] 第2问: ${r2.ok ? 'ANSWERED' : 'NO-ANSWER'}(${r2.text.length} chars) ${r2.text.replace(/\s+/g, ' ').slice(0, 100)}`);

    const stillLoggedIn = (await checkLogin(page, site)).loggedIn !== false;
    console.log('[live] 两问后会话仍登录:', stillLoggedIn);
    console.log(`[live] 结论: ${r1.ok && r2.ok ? '会话内连续提问可行,登出风控触发点是重开浏览器' : '提交行为本身仍触发风控'}`);
  } finally {
    await session.release();
    await broker.destroyAll();
  }
}
main().catch((e) => {
  console.error('FAILED:', e.message.split('\n')[0]);
  process.exit(1);
});
