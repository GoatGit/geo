// 本地探针:服务协议弹窗 gate 选择器实测(元宝应命中并点「同意」;DeepSeek 不应命中)。
// 用法:cd apps/worker-web && node scripts/probe-agreement.local.js yuanbao|deepseek
import { chromium } from 'playwright-core';

const engine = process.argv[2] ?? 'yuanbao';
const rendered = (loc) => loc.evaluate((el) => !!(el.offsetParent || el.getClientRects().length)).catch(() => false);

async function acceptAgreementDialog(page) {
  for (const frame of page.frames()) {
    const gate = frame.getByText(/服务协议及隐私|服务协议和隐私|阅读并同意.*(用户服务协议|服务协议)/).first();
    if (!(await rendered(gate))) continue;
    console.log(`[gate] frame=${frame.url().slice(0, 60)} 命中协议弹窗文案`);
    for (const label of ['同意', '同意并继续', '接受并继续']) {
      const btn = frame.getByRole('button', { name: label }).first();
      if (await rendered(btn)) {
        console.log(`[gate] button role 命中:「${label}」→ 点击`);
        await btn.click({ force: true, timeout: 2000 }).catch((e) => console.log('点击失败', e.message));
        return true;
      }
      const txt = frame.getByText(label, { exact: true }).first();
      if (await rendered(txt)) {
        console.log(`[gate] text 命中:「${label}」→ 点击`);
        await txt.click({ force: true, timeout: 2000 }).catch((e) => console.log('点击失败', e.message));
        return true;
      }
    }
    console.log('[gate] 弹窗在场但未找到同意类按钮!');
  }
  return false;
}

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (engine === 'yuanbao') {
  await page.goto('https://yuanbao.tencent.com/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  for (const hint of ['请登录', '登录', '立即登录']) {
    const loc = page.getByText(hint, { exact: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      console.log(`[yuanbao] 点「${hint}」`);
      await loc.click().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(3_000);
  // 先试一次 gate(很多情况首访就弹协议)
  console.log('[yuanbao] 打开登录后 gate 命中:', await acceptAgreementDialog(page));
  // 切手机页签 → 填号 → 点发码,触发协议弹窗的生产场景
  for (const tab of ['手机', '手机号登录']) {
    const t = page.getByText(tab, { exact: true }).first();
    if (await t.isVisible().catch(() => false)) { await t.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(1_500);
  const phone = page.locator('input[type=tel], input[placeholder*=手机号]').first();
  if (await phone.isVisible().catch(() => false)) {
    await phone.click();
    await phone.pressSequentially('16289235138', { delay: 60 });
    for (const label of ['获取验证码', '发送验证码']) {
      const b = page.getByText(label, { exact: true }).first();
      if (await b.isVisible().catch(() => false)) { console.log(`[yuanbao] 点「${label}」`); await b.click().catch(() => {}); break; }
    }
  } else {
    console.log('[yuanbao] 手机输入框未出现');
  }
  await page.waitForTimeout(2_500);
  console.log('[yuanbao] 发码后 gate 命中(期望 true):', await acceptAgreementDialog(page));
} else {
  await page.goto('https://chat.deepseek.com/sign_in', { timeout: 60_000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  console.log('[deepseek] 登录页 gate 命中(期望 false):', await acceptAgreementDialog(page));
  // 填号点发码后再验一次(确认码发送流程里也不会误点)
  const phone = page.locator('input[type=tel]').first();
  if (await phone.isVisible().catch(() => false)) {
    await phone.click();
    await phone.pressSequentially('16289235138', { delay: 60 });
    const b = page.getByText('发送验证码', { exact: false }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(3_000); }
  }
  console.log('[deepseek] 发码后 gate 命中(期望 false):', await acceptAgreementDialog(page));
}
await page.screenshot({ path: `/tmp/probe-agreement-${engine}.png` });
console.log('截图: /tmp/probe-agreement-' + engine + '.png');
await page.waitForTimeout(2_000);
await browser.close();
