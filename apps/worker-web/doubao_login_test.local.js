/** 本地调试:豆包手机号验证码登录全流程(chrome 本机浏览器,有头)。 */
const { chromium } = require('playwright-core');
const TOKEN = 'AeMkj5ncmTlYCtNucZpb1nQMyBAvtY1T';
const BASE = 'https://sms.yangsea.top';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sms(path, init) {
  const resp = await fetch(BASE + path, {
    method: init?.method || 'GET',
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.json ? JSON.stringify(init.json) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`SMS HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function visibleAcrossFrames(page, selector, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    if (Date.now() >= deadline) return null;
    await sleep(120);
  }
}

async function clickableTextAcrossFrames(page, text, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      const byRole = frame.getByRole('button', { name: new RegExp(text) }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;
      const byText = frame.getByText(text, { exact: false }).first();
      if (await byText.isVisible().catch(() => false)) return byText;
    }
    if (Date.now() >= deadline) return null;
    await sleep(120);
  }
}

async function dismissPromos(page) {
  for (const sel of ['[class*="close" i]:visible', '[aria-label*="关闭" i]:visible']) {
    const els = page.locator(sel);
    const n = await els.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) await els.nth(i).click({ timeout: 300 }).catch(() => undefined);
  }
  await page.keyboard.press('Escape').catch(() => undefined);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();

  console.log('[1] 打开豆包…');
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(3000);
  console.log('[1] frames:', page.frames().map((f) => f.url().slice(0, 70)));

  console.log('[2] 清弹窗 + 打开登录入口…');
  await dismissPromos(page);
  for (const h of ['button:has-text("登录")', 'a:has-text("登录")', '[data-testid="login_button"]']) {
    const loc = page.locator(h).first();
    if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => undefined); console.log('  点击登录入口:', h); break; }
  }
  await sleep(2500);

  console.log('[3] 切「手机号登录」…');
  const tab = await clickableTextAcrossFrames(page, '手机号登录', 3000);
  console.log('  手机号登录入口:', tab ? '找到' : '未找到');
  if (tab) { await tab.click().catch(() => undefined); await sleep(1500); }

  console.log('[4] 找手机号输入框…');
  const phoneSel = 'input[type=tel], input[placeholder*=手机], input[id*=phone], input[name*=phone]';
  const phoneLoc = await visibleAcrossFrames(page, phoneSel, 5000);
  if (!phoneLoc) {
    console.log('  未找到!各 frame 的 input 摘要:');
    for (const f of page.frames()) {
      const inputs = await f.locator('input').all().catch(() => []);
      for (const inp of inputs) {
        const meta = await inp.evaluate((el) => ({ type: el.type, ph: el.placeholder, id: el.id, vis: !!(el.offsetParent || el.getClientRects().length) })).catch(() => null);
        if (meta) console.log(`   frame=${f.url().slice(0, 50)} type=${meta.type} ph=${meta.ph} id=${meta.id} vis=${meta.vis}`);
      }
    }
    await browser.close();
    process.exit(1);
  }
  console.log('  找到手机号输入框');

  // 收码站取号
  console.log('[5] 收码站取号…');
  const sess = await sms('/api/session?t=' + encodeURIComponent(TOKEN) + '&slot=1&probe=0');
  console.log('  手机号:', sess.phone, '| status:', sess.status, '| attempt:', sess.attempt, '/', sess.max_attempts);

  console.log('[6] 填手机号 + 勾协议 + 发送验证码…');
  await phoneLoc.fill('');
  await phoneLoc.type(sess.phone, { delay: 60 });
  const agree = await visibleAcrossFrames(page, 'input[type=checkbox]', 500);
  if (agree) { await agree.check().catch(() => undefined); console.log('  已勾协议(input)'); }
  else {
    // 自定义圆圈勾选:点「已阅读并同意」文本左侧的圆圈
    const text = await clickableTextAcrossFrames(page, '已阅读并同意', 500);
    if (text) {
      const box = await text.boundingBox().catch(() => null);
      if (box) { await page.mouse.click(box.x - 14, box.y + box.height / 2); console.log('  点击协议圆圈(坐标)'); }
    }
  }
  // 调试:转储所有按钮/可点击文本
  for (const f of page.frames()) {
    const texts = await f.locator('button, [role=button], a, span[class*=btn], div[class*=btn]').allInnerTexts().catch(() => []);
    const hits = texts.map((t) => t.trim()).filter((t) => t && t.length <= 20);
    if (hits.length) console.log(`  frame(${f.url().slice(0, 40)}) 可点击文本:`, JSON.stringify(hits.slice(0, 25)));
  }
  let sent = false;
  for (const label of ['下一步', '发送验证码', '获取验证码', '获取短信验证码']) {
    const btn = await clickableTextAcrossFrames(page, label, 800);
    if (btn) { await btn.click().catch(() => undefined); sent = true; console.log('  点击:', label); break; }
  }
  // 转储 toast(验证协议/校验提示)
  await sleep(1200);
  for (const f of page.frames()) {
    const toasts = await f.locator('[class*="toast" i], [class*="message" i], [class*="semi-toast"]').allInnerTexts().catch(() => []);
    if (toasts.length) console.log(`  toast(${f.url().slice(0, 30)}):`, JSON.stringify(toasts));
  }
  if (!sent) { console.log('  未找到发送按钮!'); await browser.close(); process.exit(1); }

  console.log('[7] 收码站开始收取 + 轮询验证码…');
  await sms('/api/session/start', { method: 'POST', json: { t: TOKEN, slot: 1 } });
  let code = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const s = await sms('/api/session/poll', { method: 'POST', json: { t: TOKEN, slot: 1 } }).catch(() => null);
    if (!s) continue;
    if (s.status === 'completed' && s.code) { code = s.code; break; }
    if (i % 5 === 4) console.log(`  轮询 ${i + 1}: status=${s.status}`);
  }
  if (!code) { console.log('未收到验证码'); await browser.close(); process.exit(1); }
  console.log('  验证码:', code);

  console.log('[8] 回填验证码 + 提交…');
  const codeLoc = await visibleAcrossFrames(page, 'input[placeholder*=验证码], input[autocomplete=one-time-code], input[maxlength="4"], input[maxlength="6"]', 5000);
  if (codeLoc) { await codeLoc.fill(''); await codeLoc.type(code, { delay: 90 }); }
  else {
    const anyInput = await visibleAcrossFrames(page, 'input', 2000);
    if (anyInput) { await anyInput.click().catch(() => undefined); await page.keyboard.type(code, { delay: 130 }); }
  }
  for (const label of ['^登录$', '^提交$', '^下一步$']) {
    const btn = await clickableTextAcrossFrames(page, label, 800);
    if (btn) { await btn.click().catch(() => undefined); console.log('  点击提交:', label); break; }
  }

  console.log('[9] 等待登录生效…');
  await sleep(8000);
  const cookies = await context.cookies();
  console.log('cookies:', cookies.length, '| URL:', page.url().slice(0, 60));
  console.log('DONE — 浏览器保持打开 30 秒供人工检查');
  await sleep(30_000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
