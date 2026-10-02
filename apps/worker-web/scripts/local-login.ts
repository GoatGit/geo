/**
 * 临时本地登录驱动:Chrome + 青果隧道代理(与生产采集同出口),成功后凭证回收入池。
 * 用法: tsx scripts/local-login.ts --profile-id=4 --proxy=tunpool-tnmzwa.qg.net:12110
 */
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { checkLogin, siteConfigOf } from '@geo/engine-adapters';
import { browserContextOptions } from '../src/browser-context';
import type { EngineId } from '@geo/shared';

const arg = (name: string, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

async function main() {
  const envPath = path.join(__dirname, '../.env.debug');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  const profileId = arg('profile-id', '4');
  const proxy = arg('proxy');
  const email = arg('email');
  const password = arg('password');
  const apiBase = 'https://geo.gemux.cn';
  const engine = 'deepseek' as EngineId;
  const site = siteConfigOf(engine);

  // 档案指纹(UA 等)保持与采集一致
  const auth = { 'x-api-key': process.env.GEO_SKILL_API_KEY ?? '', 'content-type': 'application/json' };
  const ctxInfo = await fetch(`${apiBase}/api/admin/accounts/${profileId}/login-context`, { headers: auth }).then(r => r.json());
  const fingerprint = ctxInfo.fingerprint ?? {};

  const dir = '/tmp/geo-login/local';
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({
    ...browserContextOptions(fingerprint, proxy || null),
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  console.log(`[local] 打开 ${site.chatUrl}(出口=${proxy || '直连'})`);
  await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6_000);

  // 实时帧(供观察验证码)
  const stop = { value: false };
  void (async () => {
    while (!stop.value) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 8_000 }).catch(() => null);
      if (buf) writeFileSync(`${dir}/live.jpg`, buf);
      await page.waitForTimeout(900);
    }
  })();

  const loggedIn = async (): Promise<boolean> =>
    (await checkLogin(page, site).catch(() => ({ loggedIn: false }))).loggedIn === true;

  if (!(await loggedIn())) {
    if (true) writeFileSync(`${dir}/step-load.jpg`, await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8_000 }).catch(() => null) ?? Buffer.alloc(0));
    console.log(`[local] 当前 url=${page.url().slice(0, 80)}`);
    // 1) 切密码登录:DOM 级精确点击——找 textContent 恰为「密码登录」的最内层可见元素。
    //    布局两种形态(有无右侧微信扫码卡片)会让固定坐标点偏,固定坐标已弃用。
    const switched = async (): Promise<boolean> =>
      await page.locator('input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false);
    const clickToggle = async (): Promise<boolean> =>
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll<HTMLElement>('a, span, div, p, button'));
        const hits = els.filter(
          (el) => (el.textContent ?? '').trim() === '密码登录' && el.offsetWidth > 0 && el.offsetWidth < 300,
        );
        const leaf = hits[hits.length - 1];
        if (!leaf) return false;
        leaf.click();
        return true;
      });
    if (!(await switched())) {
      for (let t = 0; t < 3 && !(await switched()); t++) {
        const clicked = await clickToggle();
        console.log(`[local] 密码登录切换点击(${t + 1}/3): ${clicked ? '已点' : '未找到元素'}`);
        await page.waitForTimeout(1_500);
      }
    }
    if (!(await switched())) {
      writeFileSync(`${dir}/toggle-fail.jpg`, (await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8_000 }).catch(() => null)) ?? Buffer.alloc(0));
      console.error('[local] 密码登录切换失败(截图已存 toggle-fail.jpg)');
      stop.value = true;
      await browser.close();
      process.exit(2);
    }
    // 诊断:列出所有可见输入框的 placeholder/type
    const inputs = await page.locator('input').all();
    for (const inp of inputs) {
      const ph = await inp.getAttribute('placeholder').catch(() => null);
      const tp = await inp.getAttribute('type').catch(() => null);
      const vis = await inp.isVisible().catch(() => false);
      console.log(`[local] input type=${tp} placeholder=${ph} visible=${vis}`);
    }
    if (true) writeFileSync(`${dir}/step-tab.jpg`, await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8_000 }).catch(() => null) ?? Buffer.alloc(0));
    // 2) 填邮箱(第一个可见 text 输入)与密码
    const emailInput = page.locator('input[type="text"], input:not([type="password"])').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
    await emailInput.click();
    await page.keyboard.insertText(email);
    await page.waitForTimeout(400);
    const emailVal = (await emailInput.inputValue().catch(() => '')) ?? '';
    if (!emailVal.includes('@')) {
      console.error(`[local] 邮箱疑似填错框(实际值:${emailVal.slice(0, 30)}),中止`);
      writeFileSync(`${dir}/email-fail.jpg`, (await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8_000 }).catch(() => null)) ?? Buffer.alloc(0));
      stop.value = true;
      await browser.close();
      process.exit(3);
    }
    const pwdInput = page.locator('input[type="password"]').first();
    await pwdInput.click();
    await page.keyboard.insertText(password);
    await page.waitForTimeout(400);
    console.log('[local] 凭据已填,提交登录');
    // 3) 提交
    await page.getByRole('button', { name: /登录/ }).first().click();
    // 4) 等待结果:登录成功 / 验证码 / 报错
    let solved = false;
    for (let i = 0; i < 60 && !solved; i++) {
      await page.waitForTimeout(1_000);
      if (await loggedIn()) { solved = true; break; }
      // 有验证码/异常时把命令文件通道打开(click 注入解验证码)
      const cmdPath = `${dir}/cmd.json`;
      try {
        const st = existsSync(cmdPath) ? statSync(cmdPath) : null;
        if (st && st.mtimeMs > (globalThis as { lastCmd?: number }).lastCmd!) {
          (globalThis as { lastCmd?: number }).lastCmd = st.mtimeMs;
          const cmd = JSON.parse(readFileSync(cmdPath, 'utf8')) as { type: string; x?: number; y?: number; fromX?: number; fromY?: number; toX?: number; toY?: number; text?: string; key?: string };
          if (cmd.type === 'click' && cmd.x != null && cmd.y != null) await page.mouse.click(cmd.x, cmd.y);
          else if (cmd.type === 'drag' && cmd.fromX != null && cmd.toX != null) {
            await page.mouse.move(cmd.fromX, cmd.fromY ?? 0); await page.mouse.down();
            await page.mouse.move(cmd.toX, cmd.toY ?? 0, { steps: 25 }); await page.mouse.up();
          } else if (cmd.type === 'type' && cmd.text) await page.keyboard.insertText(cmd.text);
          else if (cmd.type === 'key' && cmd.key) await page.keyboard.press(cmd.key);
          console.log(`[cmd] ${JSON.stringify(cmd)}`);
        }
      } catch { /* 半写忽略 */ }
      if (i % 10 === 9) console.log(`[local] 等待登录完成…(${i + 1}s) url=${page.url().slice(0, 60)}`);
    }
    if (!solved) {
      writeFileSync(`${dir}/final.jpg`, (await page.screenshot({ type: 'jpeg', quality: 80, timeout: 8_000 }).catch(() => null)) ?? Buffer.alloc(0));
      console.error(`[local] 登录未完成 url=${page.url()}`);
      stop.value = true;
      await browser.close();
      process.exit(1);
    }
  }
  console.log('[local] ✅ 登录成功,处理合规弹窗(生日/年龄)…');
  await handleBirthdayOrAgeDialog(page, dir);

  console.log('[local] 导出凭证');
  const storageState = await context.storageState();
  writeFileSync(`${dir}/storage-state.json`, JSON.stringify(storageState));
  const ingest = await fetch(`${apiBase}/api/admin/accounts/${profileId}/credentials`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ storageState, proxyServer: proxy || null }),
  }).then(r => r.json());
  console.log('[local] 入池结果:', JSON.stringify(ingest));
  stop.value = true;
  await browser.close();
  process.exit(ingest?.ok ? 0 : 1);
}
main().catch(e => { console.error('[local] 异常:', e instanceof Error ? e.message : e); process.exit(1); });

/**
 * 登录后的合规弹窗(生日/年龄确认):不处理会一直挡在聊天页前,采集侧同样被挡。
 * 策略:①检测含「生日/出生日期/年龄/18」的弹层 → ②自动:年/月/日 select 各选随机
 * 成年值(1975-2000)→ 点确认类按钮 → ③识别不了时落人工通道(cmd.json 注入,live.jpg 观察)。
 */
async function handleBirthdayOrAgeDialog(page: import('playwright-core').Page, dir: string): Promise<void> {
  const writeSnap = (name: string) =>
    page.screenshot({ path: `${dir}/${name}.jpg`, quality: 75, type: 'jpeg', timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);
  for (let round = 0; round < 3; round++) {
    const hit = await page
      .getByText(/生日|出生日期|满 ?18|十八岁|年龄信息|完善信息/)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (!hit) {
      if (round === 0) console.log('[local] 未检测到生日/年龄弹窗');
      return;
    }
    console.log(`[local] 检测到合规弹窗(第 ${round + 1} 轮),尝试自动填写`);
    await writeSnap(`birthday-${round}`);
    // 年/月/日下拉:按可见 select 顺序赋随机成年值
    const selects = await page.locator('select:visible').all();
    if (selects.length >= 3) {
      const year = String(1975 + Math.floor(Math.random() * 24));
      const month = String(1 + Math.floor(Math.random() * 12));
      const day = String(1 + Math.floor(Math.random() * 28));
      const vals = [year, month, day];
      for (let i = 0; i < 3; i++) {
        await selects[i]!.selectOption(vals[i]!).catch(async () => {
          // 数字值失配时退化为按索引选(有的组件用 label)
          const n = Number(vals[i]);
          await selects[i]!.selectOption({ index: Math.min(n, 28) }).catch(() => undefined);
        });
      }
      console.log(`[local] 已选生日 ${year}-${month}-${day}`);
      await page.waitForTimeout(600);
    }
    // 确认类按钮
    const btn = page.locator('button:visible', { hasText: /确认|确定|提交|保存|开始|同意|已满|继续/ }).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      console.log('[local] 已点击确认按钮');
    } else {
      console.log('[local] 未找到确认按钮,落人工通道(90s):live.jpg 观察 + cmd.json 注入');
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(1_000);
        const still = await page.getByText(/生日|出生日期|满 ?18|年龄信息/).first().isVisible({ timeout: 1_000 }).catch(() => false);
        if (!still) break;
        try {
          const st = statSync(`${dir}/cmd.json`);
          if (st.mtimeMs > (globalThis as { lastCmd?: number }).lastCmd!) {
            (globalThis as { lastCmd?: number }).lastCmd = st.mtimeMs;
            const cmd = JSON.parse(readFileSync(`${dir}/cmd.json`, 'utf8')) as { type: string; x?: number; y?: number; text?: string; key?: string };
            if (cmd.type === 'click' && cmd.x != null && cmd.y != null) await page.mouse.click(cmd.x, cmd.y);
            else if (cmd.type === 'type' && cmd.text) await page.keyboard.insertText(cmd.text);
            else if (cmd.type === 'key' && cmd.key) await page.keyboard.press(cmd.key);
            console.log(`[cmd] ${JSON.stringify(cmd)}`);
          }
        } catch { /* 无命令文件 */ }
      }
    }
    await page.waitForTimeout(2_000);
  }
  await writeSnap('birthday-final');
}
