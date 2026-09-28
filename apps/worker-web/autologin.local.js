/** 本地全流程调试:任意引擎的手机号验证码自动登录。用法:node autologin.local.js <engine> <sms-link> */
const { chromium } = require('playwright-core');
const engine = process.argv[2] || 'deepseek';
const SMS_LINK = process.argv[3] || 'https://sms.yangsea.top/?t=AeMkj5ncmTlYCtNucZpb1nQMyBAvtY1T';
const TOKEN = (SMS_LINK.match(/[?&]t=([A-Za-z0-9_-]+)/) || [])[1];
const URLS = {
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://qianwen.com/',
  wenxin: 'https://wenxin.baidu.com/',
  yuanbao: 'https://yuanbao.tencent.com/chat',
  doubao: 'https://www.doubao.com/chat/',
};
const SMS_TABS = {
  doubao: ['手机号登录', '手机号', '验证码登录'],
  wenxin: ['短信登录', '验证码登录'],
  yuanbao: ['手机', '手机号登录'],
  qwen: [],
  deepseek: [],
};
const BASE = 'https://sms.yangsea.top';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOKEN) { console.error('链接缺 t='); process.exit(1); }

async function sms(path, init) {
  const resp = await fetch(BASE + path, {
    method: init?.method || 'GET',
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.json ? JSON.stringify(init.json) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`SMS ${resp.status}: ${JSON.stringify(data).slice(0, 120)}`);
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

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  console.log(`[1] 打开 ${engine}…`);
  await page.goto(URLS[engine], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  const phoneReady = async () => (await visibleAcrossFrames(page, 'input[type=tel], input[placeholder*=手机], input[id*=phone], input[id*=Phone]', 400)) !== null;
  const openDialog = async () => {
    for (const t of ['请登录', '登录', 'Sign in']) {
      const el = page.getByText(t, { exact: true }).first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        await el.click().catch(() => undefined);
        console.log('  点开登录:', t);
        await sleep(2500);
        return true;
      }
    }
    return false;
  };
  console.log('[2] 打开手机号登录视图…');
  if (!(await phoneReady())) {
    await openDialog();
    for (const tab of SMS_TABS[engine] ?? []) {
      if (await phoneReady()) break;
      // 先精确文本(页签常与相邻文案同容器,模糊匹配会点到容器不触发切换),再模糊
      let loc = null;
      for (const f of page.frames()) {
        const exact = f.getByText(tab, { exact: true }).first();
        if (await exact.isVisible().catch(() => false)) { loc = exact; break; }
      }
      if (!loc) loc = await clickableTextAcrossFrames(page, tab, 1500);
      if (loc) { await loc.click().catch(() => undefined); console.log('  切页签:', tab); }
      for (let i = 0; i < 20 && !(await phoneReady()); i++) await sleep(300);
    }
  }
  if (!(await phoneReady())) { console.log('!! 手机号输入框未出现'); await sleep(20000); await browser.close(); process.exit(1); }
  console.log('  手机号输入框就绪');

  console.log('[3] 收码站取号…');
  const sess = await sms('/api/session?t=' + encodeURIComponent(TOKEN) + '&slot=1&probe=0');
  console.log('  手机号:', sess.phone, '| status:', sess.status, '| attempt:', sess.attempt, '/', sess.max_attempts);
  if (!sess.phone) { console.log('!! 无可用号码'); await browser.close(); process.exit(1); }

  console.log('[4] 填号 + 勾协议 + 发码…');
  const phoneLoc = await visibleAcrossFrames(page, 'input[type=tel], input[placeholder*=手机], input[id*=phone], input[id*=Phone]', 3000);
  await phoneLoc.fill('');
  await phoneLoc.type(sess.phone, { delay: 60 });
  const agree = await visibleAcrossFrames(page, 'input[type=checkbox]', 400);
  if (agree) { await agree.check().catch(() => undefined); console.log('  勾协议(input)'); }
  else {
    const agreeText = await clickableTextAcrossFrames(page, '已阅读并同意', 400);
    if (agreeText) {
      const box = await agreeText.boundingBox().catch(() => null);
      if (box) { await page.mouse.click(box.x - 14, box.y + box.height / 2); console.log('  点协议圆圈(坐标)'); }
    }
  }
  const sendLabels = engine === 'doubao' ? ['下一步', '发送验证码', '获取验证码'] : ['获取验证码', '发送验证码', '获取短信验证码', '下一步'];
  let sent = false;
  for (const label of sendLabels) {
    const btn = await clickableTextAcrossFrames(page, label, 800);
    if (btn) { await btn.click().catch(() => undefined); sent = true; console.log('  点发码:', label); break; }
  }
  if (!sent) { console.log('!! 未找到发码按钮'); await sleep(20000); await browser.close(); process.exit(1); }

  console.log('[5] 收码 + 轮询…');
  await sms('/api/session/start', { method: 'POST', json: { t: TOKEN, slot: 1 } });
  let code = null, replaced = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const s = await sms('/api/session/poll', { method: 'POST', json: { t: TOKEN, slot: 1 } }).catch(() => null);
    if (!s) continue;
    if (s.status === 'completed' && s.code) { code = s.code; break; }
    if (s.status === 'replacing') replaced = true;
    if (i % 5 === 4) console.log(`  轮询 ${i + 1}: ${s.status}`);
  }
  if (!code) { console.log('!! 未收到验证码', replaced ? '(已换号)' : ''); await sleep(15000); await browser.close(); process.exit(1); }
  console.log('  验证码:', code);

  console.log('[6] 回填 + 提交…');
  const codeLoc = await visibleAcrossFrames(page, 'input[placeholder*=验证码], input[autocomplete=one-time-code], input[type=number], input[maxlength="4"], input[maxlength="6"]', 3000);
  if (codeLoc) { await codeLoc.fill(''); await codeLoc.type(code, { delay: 90 }); console.log('  已填验证码(input)'); }
  else {
    const any = await visibleAcrossFrames(page, 'input:visible', 1500);
    if (any) { await any.click().catch(() => undefined); await page.keyboard.type(code, { delay: 130 }); console.log('  键盘输入验证码'); }
  }
  for (const label of ['^登录$', '登录', '确定']) {
    const btn = await clickableTextAcrossFrames(page, label, 800);
    if (btn) { await btn.click().catch(() => undefined); console.log('  点提交:', label); break; }
  }

  console.log('[7] 等待登录…');
  await sleep(8000);
  const cookies = (await page.context().cookies()).length;
  console.log(`DONE cookies=${cookies} url=${page.url().slice(0, 60)}`);
  await sleep(25000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
