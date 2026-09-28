// 本地探针 2:元宝「同意」点击为何不生效——点击后验证弹窗是否消失,多策略对比。
import { chromium } from 'playwright-core';

const rendered = (loc) => loc.evaluate((el) => !!(el.offsetParent || el.getClientRects().length)).catch(() => false);

async function gateVisible(page) {
  for (const frame of page.frames()) {
    const gate = frame.getByText(/服务协议及隐私/).first();
    if (await rendered(gate)) return { frame, gate };
  }
  return null;
}

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://yuanbao.tencent.com/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4_000);
for (const hint of ['请登录', '登录', '立即登录']) {
  const loc = page.getByText(hint, { exact: true }).first();
  if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); break; }
}
await page.waitForTimeout(3_000);
for (const tab of ['手机', '手机号登录']) {
  const t = page.getByText(tab, { exact: true }).first();
  if (await t.isVisible().catch(() => false)) { await t.click().catch(() => {}); break; }
}
await page.waitForTimeout(1_500);
const phone = page.locator('input[type=tel], input[placeholder*=手机号]').first();
await phone.click();
await phone.pressSequentially('16289235138', { delay: 60 });
const send = page.getByText('获取验证码', { exact: true }).first();
await send.click().catch(() => {});
await page.waitForTimeout(2_000);

let hit = await gateVisible(page);
console.log('弹窗出现:', Boolean(hit));
if (hit) {
  const { frame } = hit;
  // 检查「同意」元素的标签与容器结构
  const info = await frame.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], .hummingbird-button, [class*=btn], [class*=button]')) {
      const t = (el.textContent || '').trim();
      if (t === '同意' || t === '取消') {
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), text: t, rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
      }
    }
    return out;
  }).catch((e) => ['evaluate失败: ' + e.message]);
  console.log('候选按钮:', JSON.stringify(info, null, 1));
  // 策略 A:role button 点击
  const btnA = frame.getByRole('button', { name: '同意' }).first();
  console.log('A role点击 前 rendered=', await rendered(btnA));
  await btnA.click({ force: true, timeout: 2_000 }).catch((e) => console.log('A点击异常', e.message?.split('\n')[0]));
  await page.waitForTimeout(1_000);
  console.log('A 点击后弹窗仍在:', Boolean(await gateVisible(page)));
  // 策略 B:坐标点击(取中心真实鼠标)
  if (await gateVisible(page)) {
    const btnB = frame.locator('button:has-text("同意"), [role=button]:has-text("同意")').first();
    const box = await btnB.boundingBox().catch(() => null);
    console.log('B boundingBox=', box);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1_000);
      console.log('B 点击后弹窗仍在:', Boolean(await gateVisible(page)));
    }
  }
  // 策略 C:footer 协议圆圈坐标点击(生产同款:文本左侧 -14px),再点发码
  if (await gateVisible(page)) {
    const agreeText = frame.getByText('我已阅读并同意', { exact: false }).first();
    const box = await agreeText.boundingBox().catch(() => null);
    console.log('C footer文本 box=', box);
    if (box) {
      await page.mouse.click(box.x + 10, box.y + box.height / 2);
      await page.waitForTimeout(800);
      console.log('C 点圆圈后弹窗仍在:', Boolean(await gateVisible(page)));
      const send2 = page.getByText('获取验证码', { exact: true }).first();
      await send2.click().catch(() => {});
      await page.waitForTimeout(1_500);
      console.log('C 再发码后弹窗仍在:', Boolean(await gateVisible(page)));
    }
  }
}
await page.screenshot({ path: '/tmp/probe-agree2.png' });
console.log('截图 /tmp/probe-agree2.png');
await page.waitForTimeout(1_500);
await browser.close();
