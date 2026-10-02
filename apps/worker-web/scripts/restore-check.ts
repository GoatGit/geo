/** 复现采集场景并处理合规弹窗:fresh context + storageState → 访问聊天页 →
 *  填写「请选择你的出生年月」弹窗(随机成年年/月)→ 导出新状态入池。
 *  用法: tsx scripts/restore-check.ts --profile-id=37 --proxy=<tunnel> [--fix]
 *  依赖: /tmp/geo-login/local/storage-state.json(local-login.ts 刚导出的同账号状态)。 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const arg = (name: string, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

/** 精确文本找叶子元素 → 真实鼠标点中心(React 自定义组件不吃合成 click)。
 *  仅用于弹窗内的触发器/确认;下拉选项走 getByText(自动滚动入视口)。 */
async function clickByText(page: import('playwright-core').Page, text: string, maxH = 60): Promise<boolean> {
  const at = await page.evaluate(
    `(() => { const els = Array.from(document.querySelectorAll('div,li,span,p,button'));
      const hit = els.filter(e => (e.textContent || '').trim() === '${text}' && e.offsetHeight > 0 && e.offsetHeight < ${maxH} && e.offsetWidth > 0);
      const el = hit[hit.length - 1];
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!at) return false;
  await page.mouse.click(at.x, at.y);
  return true;
}

async function main() {
  const envPath = path.join(__dirname, '../.env.debug');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  const profileId = arg('profile-id');
  const proxy = arg('proxy');
  const fix = process.argv.includes('--fix');
  const dir = `/tmp/geo-login/restore-${profileId}`;
  mkdirSync(dir, { recursive: true });

  const auth = { 'x-api-key': process.env.GEO_SKILL_API_KEY ?? '', 'content-type': 'application/json' };
  const ctxInfo = await fetch(`https://geo.gemux.cn/api/admin/accounts/${profileId}/login-context`, { headers: auth }).then(r => r.json());
  const fingerprint = ctxInfo.fingerprint ?? {};

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const storageState = JSON.parse(readFileSync('/tmp/geo-login/local/storage-state.json', 'utf8'));
  const context = await browser.newContext({
    userAgent: typeof fingerprint.ua === 'string' ? fingerprint.ua : undefined,
    locale: 'zh-CN',
    viewport: { width: 1366, height: 850 },
    ...(proxy ? { proxy: { server: `http://${proxy}` } } : {}),
    storageState,
  });
  const page = await context.newPage();
  console.log(`[restore] 访问聊天页(出口=${proxy || '直连'},fix=${fix})`);
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: `${dir}/after-goto.jpg`, quality: 75, type: 'jpeg', timeout: 8_000 }).catch(() => undefined);

  const dlg = page.getByText('请选择你的出生年月').first();
  const dialogVisible = await dlg.isVisible({ timeout: 4_000 }).catch(() => false);
  console.log(`[restore] 生日弹窗:${dialogVisible ? '出现' : '未出现'}`);

  if (fix && dialogVisible) {
    const year = String(2001 + Math.floor(Math.random() * 6)); // 2001-2006:稳成年且在选项面板已渲染区
    const month = String(1 + Math.floor(Math.random() * 12));
    console.log(`[restore] 填写生日:${year} 年 ${month} 月`);
    // 触发器:坐标真实点击;选项:getByText 自动滚动 + 真实点击(面板长列表可渲染在视口外)
    if (!(await clickByText(page, '年'))) throw new Error('未找到「年」下拉');
    await page.waitForTimeout(900);
    await page.getByText(year, { exact: true }).first().click({ timeout: 6_000 });
    console.log(`[restore] 年份 ${year} 已选`);
    await page.waitForTimeout(900);
    if (!(await clickByText(page, '月'))) throw new Error('未找到「月」下拉');
    await page.waitForTimeout(900);
    await page.getByText(month, { exact: true }).first().click({ timeout: 6_000 });
    console.log(`[restore] 月份 ${month} 已选`);
    await page.waitForTimeout(700);
    if (!(await clickByText(page, '确认', 50))) throw new Error('未找到「确认」按钮');
    await page.waitForTimeout(2_500);
    const gone = !(await dlg.isVisible({ timeout: 2_000 }).catch(() => false));
    console.log(`[restore] 弹窗${gone ? '已消失 ✓' : '仍存在 ✗'}`);
    await page.screenshot({ path: `${dir}/after-birthday.jpg`, quality: 75, type: 'jpeg', timeout: 8_000 }).catch(() => undefined);
    if (!gone) {
      console.error('[restore] 生日填写未生效,不覆盖入池');
      await browser.close();
      process.exit(1);
    }
    const state = await context.storageState();
    writeFileSync('/tmp/geo-login/local/storage-state.json', JSON.stringify(state));
    const ingest = await fetch(`https://geo.gemux.cn/api/admin/accounts/${profileId}/credentials`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ storageState: state, proxyServer: proxy || null }),
    }).then(r => r.json());
    console.log('[restore] 入池:', JSON.stringify(ingest));
    await browser.close();
    process.exit(ingest?.ok ? 0 : 1);
  }

  await browser.close();
  process.exit(0);
}
main().catch(e => { console.error('[restore] 异常:', e instanceof Error ? e.message : e); process.exit(1); });
