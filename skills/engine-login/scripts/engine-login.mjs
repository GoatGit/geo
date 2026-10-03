#!/usr/bin/env node
// 智能体登录技能·驱动端(自包含,无项目源码依赖):
//   npm i && node scripts/engine-login.mjs --engine=deepseek --sms-link=<收码链接> --profile-id=21 [--manual] [--keep=60]
//
// 流程:GEO API 取档案身份(指纹/出口/Context)→ AgentBay 同身份建远程会话 →
// autoPhoneLogin 机械流(填号/发码/收码/回填,人工经 cmd.json 解验证码)→
// 校验登录态 → 导出 Cookie/storageState 回收入池(X-API-Key)。
// 配置:skill 目录 .env(模板见 .env.example)。
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const SKILL_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// 平台 API 可能使用较新的 Let's Encrypt 链(ISRG Root YR),部分 Node 内置 CA 库未收录——
// 捆绑根证书(certs/isrg-yr-chain.pem),存在则平台 API 请求走该 CA;AgentBay/收码站走默认。
const CA_PATH = path.join(SKILL_DIR, 'certs', 'isrg-yr-chain.pem');
const CA = existsSync(CA_PATH) ? readFileSync(CA_PATH) : undefined;
function apiFetch(full, init = {}) {
  // 默认 CA 库优先;证书链不认(Let's Encrypt YR 代/ZeroSSL 代轮换)时回落捆绑 CA
  return fetch(full, init).catch(async (e) => {
    const code = String(e?.cause?.code ?? e?.message ?? '');
    if (!CA || !/CERT|ISSUER/i.test(code)) throw e;
    return caFetch(full, init);
  });
}
function caFetch(full, init = {}) {
  const u = new URL(full);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname,
      path: u.pathname + u.search,
      method: init.method ?? 'GET',
      headers: init.headers,
      ca: CA,
      servername: u.hostname,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        ok: !res.statusCode || res.statusCode < 400,
        status: res.statusCode,
        text: async () => body,
        json: async () => { try { return JSON.parse(body); } catch { throw new Error(`非 JSON 响应(${res.statusCode}): ${body.slice(0, 120)}`); } },
      }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ── .env 加载(不覆盖已有环境变量)────────────────────────────────────────────
const envPath = path.join(SKILL_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const arg = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

// ── 引擎站点配置(与生产 engine-adapters 对齐)───────────────────────────────
const SITES = {
  doubao: { displayName: '豆包', chatUrl: 'https://www.doubao.com/chat/', loginHints: ['button:has-text("登录")', 'a:has-text("登录")', '[data-testid="login_button"]'] },
  deepseek: { displayName: 'DeepSeek', chatUrl: 'https://chat.deepseek.com/', loginHints: [] },
  wenxin: { displayName: '百度文心助手', chatUrl: 'https://wenxin.baidu.com/', loginHints: [] },
  qwen: { displayName: '通义千问', chatUrl: 'https://www.qianwen.com/', loginHints: ['button:has-text("登录")', 'a:has-text("登录")'] },
  yuanbao: { displayName: '腾讯元宝', chatUrl: 'https://yuanbao.tencent.com/chat', loginHints: ['button:has-text("登录")', 'a:has-text("登录")'] },
};

// ── AgentBay 远程会话(POP RPC,Anonymous + Bearer key 在 form body)──────────
class AgentBay {
  constructor(cfg) {
    if (!cfg.apiToken) throw new Error('AGENTBAY_API_TOKEN is required(.env)');
    this.cfg = cfg;
  }
  async rpc(action, fields) {
    const form = new URLSearchParams({
      Action: action,
      Version: '2025-05-06',
      RegionId: this.cfg.regionId,
      Format: 'JSON',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SignatureNonce: randomUUID(),
      ...fields,
    });
    const res = await fetch(`${this.cfg.apiEndpoint}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const parsed = text.trimStart().startsWith('{') ? JSON.parse(text) : parseXmlLoose(text);
    const code = String(parsed.Code ?? 'ok');
    if (code !== 'ok' && code !== 'OK' && code !== 'Success') {
      throw new Error(`agentbay ${action} -> ${code}: ${String(parsed.Message ?? '').slice(0, 160)}`);
    }
    const data = parsed.Data ?? parsed;
    return typeof data === 'object' && data !== null ? data : parsed;
  }
  strField(obj, keys) {
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k]) return obj[k];
      const d = obj.Data;
      if (d && typeof d === 'object' && typeof d[k] === 'string') return d[k];
    }
    return undefined;
  }
  async acquire(profileKey, fingerprint, proxyHint, contextRef) {
    const auth = `Bearer ${this.cfg.apiToken}`;
    const body = { Authorization: auth };
    let contextId;
    try {
      const ctxRes = await this.rpc('GetContext', {
        ...body,
        Name: `geo-${profileKey.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`,
        AllowCreate: 'true',
      });
      contextId = this.strField(ctxRes, ['Id', 'ContextId', 'contextId']);
    } catch (e) {
      console.error('[agentbay] GetContext 失败(降级为无 Context 会话):', e.message);
    }
    // 注意:登录会话是"新会话绑定已有 Context",这里沿用档案的 contextRef;无则用 GetContext 结果
    const useContextId = contextRef || contextId;
    const createRes = await this.rpc('CreateMcpSession', {
      ...body,
      ImageId: this.cfg.imageId,
      RegionId: this.cfg.regionId,
      ManualRelease: 'true',
      Labels: JSON.stringify({ app: 'geolens' }),
    });
    const sessionId = this.strField(createRes, ['SessionId', 'sessionId']);
    if (!sessionId) throw new Error(`agentbay create: no SessionId: ${JSON.stringify(createRes).slice(0, 200)}`);
    if (useContextId) {
      try {
        const ctxPath = this.cfg.contextPath;
        await this.rpc('BindContexts', {
          ...body,
          SessionId: sessionId,
          PersistenceDataList: JSON.stringify([{ ContextId: useContextId, Path: ctxPath }]),
        });
        for (let i = 0; i < 6; i++) {
          const res = await this.rpc('DescribeSessionContexts', { ...body, SessionId: sessionId });
          if (JSON.stringify(res).includes(useContextId)) break;
          await new Promise((r) => setTimeout(r, 2_000));
        }
        contextId = useContextId;
      } catch (e) {
        console.warn(`[agentbay] Context 绑定失败(降级为无 Context 会话): ${e.message}`);
        contextId = undefined;
      }
    }
    try {
      await this.rpc('InitBrowser', {
        ...body,
        SessionId: sessionId,
        BrowserOption: JSON.stringify({ fingerprint, proxy: proxyHint }),
      }).catch((e) => console.error('[agentbay] InitBrowser 失败(非致命):', e.message));
      const linkRes = await this.rpc('GetCdpLink', { ...body, SessionId: sessionId });
      const cdpUrl = this.strField(linkRes, ['Url', 'url', 'WsUrl', 'Link']);
      if (!cdpUrl) throw new Error(`agentbay: no CDP url: ${JSON.stringify(linkRes).slice(0, 200)}`);
      return { sessionId, cdpUrl, contextId, release: async () => { await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId }).catch(() => undefined); } };
    } catch (err) {
      await this.rpc('ReleaseMcpSession', { ...body, SessionId: sessionId }).catch(() => undefined);
      throw err;
    }
  }
}

function parseXmlLoose(text) {
  const out = {};
  for (const tag of ['Code', 'Message', 'Success', 'RequestId', 'HttpStatusCode']) {
    const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    if (m) out[tag] = m[1];
  }
  const dataBlock = text.match(/<Data>([\s\S]*?)<\/Data>/);
  if (dataBlock) for (const m of dataBlock[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  return out;
}

// ── 收码站客户端 ─────────────────────────────────────────────────────────────
class SmsLinkClient {
  constructor(token, baseUrl = 'https://sms.yangsea.top') {
    this.token = token;
    this.baseUrl = baseUrl;
  }
  async call(p, init) {
    const resp = await fetch(`${this.baseUrl}${p}`, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'content-type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text.slice(0, 120);
      try { const j = JSON.parse(text); detail = typeof j.detail === 'string' ? j.detail : j.message ?? detail; } catch {}
      throw new Error(`收码站请求失败(HTTP ${resp.status}):${detail}`);
    }
    return JSON.parse(text);
  }
  getSession(slot = 1) { return this.call(`/api/session?t=${encodeURIComponent(this.token)}&slot=${slot}&probe=0`); }
  startCollect(slot = 1) { return this.call('/api/session/start', { method: 'POST', json: { t: this.token, slot } }); }
  poll(slot = 1) { return this.call('/api/session/poll', { method: 'POST', json: { t: this.token, slot } }); }
  resetTimer(slot = 1) { return this.call('/api/session/reset-timer', { method: 'POST', json: { t: this.token, slot } }); }
}

function smsTokenFromLink(link) {
  return /[?&]t=([A-Za-z0-9_-]+)/.exec(link.trim())?.[1] ?? null;
}

// ── 页面助手(与生产 login-manager 同语义)──────────────────────────────────
/** 原生渲染判定:transform 缩放弹窗会被 isVisible 误判。 */
const rendered = (loc) => loc.evaluate((el) => !!(el.offsetParent || el.getClientRects().length)).catch(() => false);

/** 跨 frame 查找:遍历全部匹配取首个原生渲染可见的(.first()+isVisible 会误判/落空)。 */
async function visibleAcrossFrames(page, selector, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      const all = frame.locator(selector);
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const loc = all.nth(i);
        if (await rendered(loc)) return loc;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(120).catch(() => undefined);
  }
}

/** 跨 frame 按文本/角色查找可点击元素(注意:字符串形式 locator.evaluate 从不执行,必须传真函数)。 */
async function clickableTextAcrossFrames(page, text, timeoutMs = 1_000) {
  const re = new RegExp(text);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      for (const cand of [frame.getByRole('button', { name: re }), frame.getByText(re)]) {
        const n = await cand.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 6); i++) {
          const loc = cand.nth(i);
          if (await rendered(loc)) return loc;
        }
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(120).catch(() => undefined);
  }
}

/** React 受控输入:fill('')(原生 setter + input 事件)清空,再全选退格兜底,最后逐字键入。 */
async function typeIntoField(page, loc, value, delayMs = 60) {
  await loc.click({ force: true }).catch(() => undefined);
  await loc.fill('', { force: true }).catch(() => undefined);
  await page.keyboard.press('ControlOrMeta+a').catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
  await loc.pressSequentially(value, { delay: delayMs }).catch(async () => {
    await page.keyboard.type(value, { delay: delayMs });
  });
}

/** 服务协议确认弹窗(元宝等):弹窗文案在场才点「同意」,点后复核真的关闭否则重试。 */
async function acceptAgreementDialog(page) {
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let acted = false;
    for (const frame of page.frames()) {
      const gate = frame.getByText(/服务协议及隐私|服务协议和隐私|阅读并同意.*(用户服务协议|服务协议)/).first();
      if (!(await rendered(gate))) continue;
      for (const label of ['同意', '同意并继续', '接受并继续']) {
        const btn = frame.getByRole('button', { name: label }).first();
        if (await rendered(btn)) { await btn.click({ force: true, timeout: 2_000 }).catch(() => undefined); acted = true; break; }
        const txt = frame.getByText(label, { exact: true }).first();
        if (await rendered(txt)) { await txt.click({ force: true, timeout: 2_000 }).catch(() => undefined); acted = true; break; }
      }
      if (acted) break;
    }
    if (!acted) return clicked;
    clicked = true;
    await page.waitForTimeout(600);
  }
  return clicked;
}

/** 人机验证检测(图形/滑块/3D 点选)。 */
async function detectHumanCheck(page) {
  if (await visibleAcrossFrames(page, 'iframe[src*=captcha], iframe[src*=verify], iframe[src*=geetest], iframe[src*=dingxiang], iframe[title*="验证"]', 300)) return true;
  for (const mark of ['拖动滑块', '拖动下方滑块', '安全验证', '图形验证', '完成拼图', '点击图中', '请点击']) {
    if (await clickableTextAcrossFrames(page, mark, 120)) return true;
  }
  return false;
}

/** 引擎精确字段(通用 placeholder 会命中同弹窗其它 tab 的输入框)。 */
const EXACT_LOGIN_FIELDS = {
  wenxin: { phone: 'input[id*=smsPhone]', code: 'input[id*=smsVerifyCode]' },
  qwen: { phone: 'input[id*=fm-sms-login-id]', code: 'input[id*=fm-smscode]' },
};
/** 引擎 → 手机号登录页签(deepseek/qwen 表单直出为空)。 */
const SMS_TABS = {
  doubao: ['手机号登录', '手机号', '验证码登录'],
  wenxin: ['[id*=changeSmsCodeItem]'],
  yuanbao: ['手机', '手机号登录'],
  qwen: [],
  deepseek: [],
};

/** 手机号验证码自动登录机械流(与生产 login-manager.autoPhoneLogin 同步移植)。 */
async function runAutoPhoneLogin(page, site, sms, status) {
  await dismissPromos(page);
  await acceptAgreementDialog(page);

  const exactFields = EXACT_LOGIN_FIELDS[site.engine] ?? {};
  const loginDialogOpen = async () => {
    if (await phoneInputReady()) return true;
    for (const mark of ['扫码', '短信登录', '验证码登录', '微信\\n手机']) {
      if (await clickableTextAcrossFrames(page, mark, 300)) return true;
    }
    return false;
  };
  const openLoginDialog = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const cand of [page.getByText('登录', { exact: true }).first(), ...site.loginHints.map((h) => page.locator(h).first())]) {
        if (await cand.isVisible({ timeout: 400 }).catch(() => false)) {
          await cand.click({ timeout: 2_000 }).catch(() => undefined);
          for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(400);
            if (await loginDialogOpen()) return true;
          }
        }
      }
    }
    return false;
  };
  const phoneInputReady = async () =>
    (await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 400)) !== null;
  const openPhoneInput = async () => {
    if (await phoneInputReady()) return true;
    await openLoginDialog();
    for (const retry of [1, 2]) {
      await acceptAgreementDialog(page);
      for (const tabText of SMS_TABS[site.engine] ?? ['手机号登录', '验证码登录']) {
        let tabLoc = null;
        let force = false;
        if (tabText.startsWith('[') || tabText.startsWith('#')) {
          tabLoc = await visibleAcrossFrames(page, tabText, 1_500);
          force = true;
        }
        const deepRes = await page.evaluate((txt) => {
          const els = [...document.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === txt);
          if (!els.length) return null;
          const el = els[els.length - 1];
          const r = el.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
          el.dispatchEvent(new PointerEvent('pointerdown', o));
          el.dispatchEvent(new MouseEvent('mousedown', o));
          el.dispatchEvent(new PointerEvent('pointerup', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          el.click();
          return `${el.tagName}@${Math.round(r.x)},${Math.round(r.y)}`;
        }, tabText).catch(() => null);
        if (deepRes) {
          for (let i = 0; i < 30; i++) {
            await page.waitForTimeout(300);
            if (await phoneInputReady()) return true;
          }
          continue;
        }
        if (!tabLoc) {
          for (const frame of page.frames()) {
            const exact = frame.getByText(tabText, { exact: true }).first();
            if (await rendered(exact)) { tabLoc = exact; break; }
          }
        }
        if (!tabLoc) tabLoc = await clickableTextAcrossFrames(page, tabText, 1_500);
        if (tabLoc) {
          await tabLoc.click(force ? { force: true } : { timeout: 2_000 }).catch(() => undefined);
          for (let i = 0; i < 45; i++) {
            await page.waitForTimeout(300);
            if (await phoneInputReady()) return true;
          }
        }
      }
      if (retry === 1) await openLoginDialog();
    }
    return false;
  };
  if (!(await openPhoneInput())) {
    const frameUrls = page.frames().map((f) => f.url().slice(0, 60)).join(' | ');
    throw new Error(`未能打开${site.displayName}手机号登录视图;frames=[${frameUrls}]`);
  }

  const autoDeadline = Date.now() + 480_000;
  const resentPhones = new Set();
  const digits = (v) => String(v).replace(/\D/g, '');
  const stationFailed = async (st) => {
    if (st.status !== 'failed') return false;
    if ((st.attempt ?? 0) < (st.max_attempts ?? 1) && Date.now() < autoDeadline - 60_000) {
      await status(`收码站判定号码失败(${st.attempt ?? '?'}/${st.max_attempts ?? '?'}),等待站方换号后重取…`);
      await page.waitForTimeout(20_000);
      return true;
    }
    throw new Error(`收码站判定号码失败(次数已用尽 ${st.attempt ?? '?'}/${st.max_attempts ?? '?'}),请更换收码链接`);
  };
  const submitCode = async (phone, code) => {
    await status(`验证码已收到(${code}),正在回填${site.displayName}…`);
    const phoneLoc = await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 3_000);
    if (phoneLoc) await typeIntoField(page, phoneLoc, phone, 60);
    const codeLoc = await visibleAcrossFrames(page, exactFields.code || 'input[placeholder*=验证码], input[autocomplete=one-time-code], input[type=number], input[maxlength="4"], input[maxlength="6"]', 3_000);
    if (codeLoc) {
      await typeIntoField(page, codeLoc, code, 80);
    } else {
      const anyInput = await visibleAcrossFrames(page, 'input', 2_000);
      if (anyInput) { await anyInput.click({ force: true }).catch(() => undefined); await page.keyboard.type(code, { delay: 120 }); }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const submit = await clickableTextAcrossFrames(page, '^登录$|^提交$|^确定$', 2_000);
      if (submit) await submit.click({ timeout: 2_000, force: true }).catch(() => undefined);
      let formGone = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(500);
        if (!(await phoneInputReady())) { formGone = true; break; }
      }
      if (formGone) { await status('已提交登录,等待登录态确认…'); break; }
      if (attempt === 1) await page.keyboard.press('Enter').catch(() => undefined);
    }
  };

  for (let round = 1; round <= 6 && Date.now() < autoDeadline; round++) {
    if (!(await phoneInputReady()) && !(await openPhoneInput())) throw new Error('登录视图丢失');
    // 站方换号进行中会拒绝请求(HTTP 409「正在换号」):稍候重试而不是整体失败
    const smsRetry = async (fn, tries = 4) => {
      let lastErr;
      for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (err) { lastErr = err; await page.waitForTimeout(4_000); }
      }
      throw lastErr;
    };
    const session = await smsRetry(() => sms.getSession());
    if (await stationFailed(session)) { round--; continue; }
    // start 先行(发码之前):以 start 返回的号码为准填表,短信才发进被监控的号
    const started = await smsRetry(() => sms.startCollect(session.slot ?? 0));
    if (await stationFailed(started)) { round--; continue; }
    const phone = [started.phone, session.phone].find((p) => p && digits(p).length >= 11) ?? session.phone ?? started.phone ?? '';
    if (!phone) throw new Error('收码站未返回手机号');
    const slot = session.slot ?? 0;
    // 抢救已有验证码:站里已有 completed+code 直接回填,过期才重取号重发
    if (started.status === 'completed' && started.code) {
      await submitCode(phone, started.code);
      if (await loggedInGeneric(page, site)) return;
      await status('站内已有验证码回填未通过(可能已过期),重新取号发送…');
      continue;
    }
    await status(`第 ${round} 轮:手机号 ${phone},正在填入${site.displayName}并发送验证码…`);

    await page.getByText(/暂不下载|以后再说|暂不使用/).first().click({ timeout: 300 }).catch(() => undefined);
    const phoneLoc = await visibleAcrossFrames(page, exactFields.phone || 'input[type=tel], input[placeholder*=手机], input[id*=phone]', 3_000);
    if (!phoneLoc) throw new Error('手机号输入框未找到(可能被弹窗遮挡)');
    await typeIntoField(page, phoneLoc, phone, 60);
    // 协议勾选:label 走找(元宝:文案向 label 找关联勾选框)→ 标准 checkbox → 自定义圆圈坐标点击
    const agreeWalk = await page.evaluate(() => {
      const visCbs = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')].filter((i) => i.offsetParent || i.getClientRects().length);
      if (visCbs.some((i) => i.checked)) return 'already';
      const t = [...document.querySelectorAll('*')].filter((e) => e.children.length <= 1 && /我已阅读并同意/.test(e.textContent || '')).pop();
      if (!t) return 'no text';
      const root = t.closest('label') || t.parentElement;
      const cb = root && (root.querySelector('input[type=checkbox],input[type=radio]') || (root.parentElement && root.parentElement.querySelector('input[type=checkbox],input[type=radio]')));
      if (!cb) return 'no cb';
      cb.click();
      return `clicked: ${cb.checked}`;
    }).catch(() => 'eval err');
    const agreeInput = agreeWalk.startsWith('clicked') || agreeWalk === 'already' ? null : await visibleAcrossFrames(page, 'input[type=checkbox]', 400);
    if (agreeInput) {
      await agreeInput.check({ timeout: 1_000 }).catch(() => undefined);
    } else if (!agreeWalk.startsWith('clicked') && agreeWalk !== 'already') {
      const agreeText = await clickableTextAcrossFrames(page, '已阅读并同意', 500);
      if (agreeText) {
        const box = await agreeText.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x - 14, box.y + box.height / 2).catch(() => undefined);
      }
    }
    const sendLabels = site.engine === 'doubao'
      ? ['下一步', '发送验证码', '获取验证码', '重新发送', '重新获取']
      : ['获取验证码', '发送验证码', '获取短信验证码', '重新发送', '重新获取', '下一步'];
    const clickSend = async () => {
      if (site.engine === 'wenxin') {
        const btn = await visibleAcrossFrames(page, '[id*=smsTimer]', 2_000);
        if (btn) { await btn.click({ force: true }).catch(() => undefined); return true; }
      }
      for (const label of sendLabels) {
        const btn = await clickableTextAcrossFrames(page, label, 800);
        if (btn) { await btn.click({ timeout: 2_000, force: true }).catch(() => undefined); return true; }
      }
      return false;
    };
    if (!(await clickSend())) {
      // 倒计时态(码已在发送中):没有可点发送按钮,视作已发送直接收码
      let counting = false;
      for (const frame of page.frames()) {
        if (await rendered(frame.getByText(/秒后.{0,4}(获取|发送)|重新获取|重新发送/).first())) { counting = true; break; }
      }
      if (!counting) throw new Error(`${site.displayName}登录页未找到发送验证码按钮`);
    }
    if (await acceptAgreementDialog(page)) await clickSend();
    // 倒计时校验:没出现说明点击未触发,DOM 深度点击补一发(元宝实测 locator 点击不生效)
    let countdown = false;
    for (let i = 0; i < 4 && !countdown; i++) {
      await page.waitForTimeout(700);
      for (const frame of page.frames()) {
        if (await rendered(frame.getByText(/秒后.{0,4}(获取|发送|重发)|重新发送|重新获取/).first())) { countdown = true; break; }
      }
    }
    if (!countdown) {
      await page.evaluate((txts) => {
        const els = [...document.querySelectorAll('button,span,a,div')].filter((e) => e.children.length === 0 && txts.some((t) => (e.textContent || '').trim() === t));
        if (!els.length) return 'no btn';
        const el = els[els.length - 1];
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new PointerEvent('pointerup', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.click();
        return 'deep clicked: ' + el.textContent.trim();
      }, sendLabels).catch(() => undefined);
      if (await acceptAgreementDialog(page)) await clickSend();
    }

    let code = null;
    let rotated = false;
    let captchaNoted = false;
    const POLL_MAX = 100; // 200s:留出补发轮预算,否则 300s 吃光 8 分钟补发永远轮不到
    for (let poll = 0; poll < POLL_MAX && Date.now() < autoDeadline; poll++) {
      await page.waitForTimeout(2_000);
      const s = await sms.poll(slot).catch(() => null);
      if (s) {
        if (s.status === 'completed' && s.code) { code = s.code; break; }
        if (s.status === 'failed') break;
        if (s.status === 'replacing' || (s.phone && digits(s.phone) !== digits(phone))) { rotated = true; break; }
      }
      if (poll > 0 && poll % 10 === 0) {
        const humanCheck = await detectHumanCheck(page);
        // 全程持续续收取窗口:站方 wait_seconds≈65s 到期自动换号,而虚拟运营商短信
        // 投递延迟可达 60-90s——只在验证码期间续命不够,发码后也要一直续
        await sms.resetTimer(slot).catch(() => undefined);
        if (humanCheck) {
          if (!captchaNoted) {
            captchaNoted = true;
            await status('检测到人机验证(图形/滑块),请在下方画面手动完成,完成后自动继续收取验证码…');
          } else {
            await status(`人机验证等待中(${poll * 2}s),已续收取窗口…`);
          }
        } else {
          await status(`等待短信验证码(${poll * 2}s/${POLL_MAX * 2}s),已续收取窗口…`);
        }
      }
    }
    if (!code) {
      if (rotated) { await status('收码站已换号(旧号短信作废),用新号重走流程…'); continue; }
      if (!resentPhones.has(phone) && Date.now() < autoDeadline - 60_000) {
        resentPhones.add(phone);
        await status(`验证码超时未收到,对 ${phone} 补发一次…`);
        round--;
        continue;
      }
      throw new Error(`超时未收到验证码${resentPhones.has(phone) ? '(已补发过一次)' : ''}${captchaNoted ? ',人机验证可能未完成' : ''},请更换收码链接后重试`);
    }
    await submitCode(phone, code);
    return;
  }
  throw new Error('自动登录预算用尽(多次换号/补发)仍未收到可用验证码,请更换收码链接后重试');
}

/** 关闭运营弹窗(下载客户端等)。 */
async function dismissPromos(page) {
  const candidates = [
    page.locator('[class*="close" i]:visible'),
    page.locator('[aria-label*="关闭" i]:visible, [aria-label*="close" i]:visible'),
    page.getByText(/^(×|×|x|X|关闭|跳过|暂不下载|暂不使用|以后再说|暂不)$/),
  ];
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) await c.nth(i).click({ timeout: 300 }).catch(() => undefined);
  }
  await page.keyboard.press('Escape').catch(() => undefined);
}

/** 通用登录态判定:URL 离开登录页且页面无「登录」主按钮。配合画面人工确认(done.flag 可强制)。 */
async function loggedInGeneric(page, _site) {
  const u = page.url();
  if (/sign_in|\/login/i.test(u)) return false;
  const stillLoginBtn = await clickableTextAcrossFrames(page, '^登录$', 400);
  if (stillLoginBtn) {
    // 首页常有"登录"入口但已是会话态的站点(豆包),再验输入框:有提问框即视为已登录
    const hasInput = await visibleAcrossFrames(page, 'textarea, [contenteditable=true]', 600);
    return Boolean(hasInput);
  }
  return true;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const engine = arg('engine', 'deepseek');
  const smsLink = arg('sms-link');
  const profileId = arg('profile-id');
  const apiBase = (process.env.GEO_API_BASE || arg('api', 'https://geo.gemux.cn')).replace(/\/$/, '');
  const manual = process.argv.includes('--manual');
  const keepMs = Number(arg('keep', '60')) * 1000;
  if (!SITES[engine]) { console.error(`未知引擎: ${engine}(支持 ${Object.keys(SITES).join('/')})`); process.exit(1); }
  if (!smsLink || !profileId) {
    console.error('用法: node scripts/engine-login.mjs --engine=deepseek --sms-link=<收码链接> --profile-id=<档案ID> [--manual] [--keep=60]');
    process.exit(1);
  }
  const site = { engine, ...SITES[engine] };
  const token = smsTokenFromLink(smsLink);
  if (!token) { console.error('收码链接无法解析(缺 t= 参数)'); process.exit(1); }

  // 1. 鉴权:X-API-Key 优先,回落开发短信后门
  const skillKey = (process.env.GEO_SKILL_API_KEY ?? '').trim();
  let auth;
  if (skillKey) {
    auth = { 'x-api-key': skillKey, 'content-type': 'application/json' };
    console.log('[login] 鉴权:X-API-Key');
  } else {
    const adminPhone = (process.env.GEO_ADMIN_PHONE ?? '').trim();
    if (!adminPhone) throw new Error('请配置 GEO_SKILL_API_KEY;仅开发环境可显式设置 GEO_ADMIN_PHONE 使用 devCode 登录');
    const codeResp = await apiFetch(`${apiBase}/api/auth/sms/code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: adminPhone }),
    }).then((r) => r.json());
    if (!codeResp?.devCode) throw new Error(`获取 admin 登录码失败: ${JSON.stringify(codeResp)}`);
    const authResp = await apiFetch(`${apiBase}/api/auth/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: adminPhone, code: codeResp.devCode }),
    }).then((r) => r.json());
    if (!authResp?.accessToken) throw new Error('admin 登录失败');
    auth = { authorization: `Bearer ${authResp.accessToken}`, 'content-type': 'application/json' };
    console.log('[login] 鉴权:admin JWT(未配置 GEO_SKILL_API_KEY,建议全局配置生成技能 Key)');
  }

  // 2. 档案登录上下文
  const ctx = await apiFetch(`${apiBase}/api/admin/accounts/${profileId}/login-context`, { headers: { authorization: auth.authorization ?? '', 'x-api-key': auth['x-api-key'] ?? '' } }).then((r) => r.json());
  if (!ctx?.id) throw new Error(`读取档案登录上下文失败: ${JSON.stringify(ctx).slice(0, 160)}`);
  console.log(`[login] 档案 #${ctx.id} engine=${ctx.engine} status=${ctx.status} 出口=${ctx.proxyServer ?? '(直连)'}`);

  // 3. 远程会话(同一指纹/出口/Context)
  const dir = `/tmp/auto-login-debug/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  mkdirSync(dir, { recursive: true });
  const agentbay = new AgentBay({
    apiEndpoint: process.env.AGENTBAY_API_ENDPOINT ?? 'https://agentbay.cn-shanghai.aliyuncs.com',
    apiToken: process.env.AGENTBAY_API_TOKEN ?? '',
    imageId: process.env.AGENTBAY_IMAGE_ID ?? 'browser_latest',
    regionId: process.env.AGENTBAY_REGION_ID ?? 'cn-shanghai',
    contextPath: process.env.AGENTBAY_CONTEXT_PATH ?? '/home/wuying/workspace',
  });
  const fingerprint = ctx.fingerprint ?? { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', viewport: '1366x850', locale: 'zh-CN' };
  let sessionHandle = null;
  let released = false;
  // AgentBay Context 的登录态同步依赖优雅释放——所有退出路径都必须先 release
  const releaseSession = async () => {
    if (released) return;
    released = true;
    stop.value = true;
    try { await sessionHandle?.release(); } catch {}
  };
  const finish = async (code) => {
    stop.value = true;
    await releaseSession();
    process.exit(code);
  };
  process.on('SIGINT', () => void finish(0));
  process.on('SIGTERM', () => void finish(0));
  const session = await agentbay.acquire(`profile:${profileId}`, fingerprint, ctx.proxyServer ?? undefined, ctx.contextRef ?? undefined);
  sessionHandle = session;
  console.log(`[login] AgentBay 会话已建立 context=${session.contextId?.slice(0, 20) ?? '无'}`);
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const contextOpts = {
    ...(typeof fingerprint.ua === 'string' && fingerprint.ua ? { userAgent: fingerprint.ua } : {}),
    locale: typeof fingerprint.locale === 'string' && fingerprint.locale ? fingerprint.locale : 'zh-CN',
    viewport: (() => {
      const m = typeof fingerprint.viewport === 'string' ? /^(\d+)x(\d+)$/.exec(fingerprint.viewport) : null;
      return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1366, height: 850 };
    })(),
    ...(ctx.proxyServer ? { proxy: { server: `http://${ctx.proxyServer}` } } : {}),
  };
  const context = await browser.newContext(contextOpts);
  const page = context.pages()[0] ?? (await context.newPage());
  console.log(`[login] 打开 ${site.chatUrl}`);
  await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  let seq = 0;
  const status = async (detail) => {
    console.log(`[status] ${new Date().toISOString().slice(11, 19)} ${detail}`);
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5_000 }).catch(() => null);
    if (buf) writeFileSync(`${dir}/snap-${String(++seq).padStart(3, '0')}.jpg`, buf);
  };
  const stop = { value: false };
  const frameLoop = (async () => {
    while (!stop.value) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5_000 }).catch(() => null);
      if (buf) writeFileSync(`${dir}/live.jpg`, buf);
      await page.waitForTimeout(2_000).catch(() => undefined);
    }
  })();
  void frameLoop;
  let lastCmdMtime = 0;
  const cmdLoop = (async () => {
    const cmdPath = `${dir}/cmd.json`;
    while (!stop.value) {
      await page.waitForTimeout(500).catch(() => undefined);
      try {
        const st = existsSync(cmdPath) ? statSync(cmdPath) : null;
        if (!st || st.mtimeMs === lastCmdMtime) continue;
        lastCmdMtime = st.mtimeMs;
        const cmd = JSON.parse(readFileSync(cmdPath, 'utf8'));
        if (cmd.type === 'click' && cmd.x != null && cmd.y != null) {
          await page.mouse.click(cmd.x, cmd.y);
        } else if (cmd.type === 'drag' && cmd.fromX != null && cmd.toX != null) {
          await page.mouse.move(cmd.fromX, cmd.fromY ?? 0);
          await page.mouse.down();
          await page.mouse.move(cmd.toX, cmd.toY ?? cmd.fromY ?? 0, { steps: 25 });
          await page.mouse.up();
        } else if (cmd.type === 'type' && cmd.text) {
          await page.keyboard.insertText(cmd.text);
        } else if (cmd.type === 'key' && cmd.key) {
          await page.keyboard.press(cmd.key);
        } else if (cmd.type === 'js' && cmd.expr) {
          // 跨 frame 求值:登录弹窗常是嵌入 iframe(元宝=微信 qrconnect),主文档 eval 够不到
          for (const f of page.frames()) {
            const r = await f.evaluate(cmd.expr).catch((e) => `ERR: ${e.message?.slice(0, 100)}`);
            const out = typeof r === 'undefined' ? null : r;
            if (out !== null) console.log(`[js] ${f.url().slice(0, 50)} → ${JSON.stringify(out)?.slice(0, 700)}`);
          }
          continue;
        } else continue;
        console.log(`[cmd] 已执行 ${JSON.stringify(cmd)}`);
      } catch { /* 半写状态忽略 */ }
    }
  })();
  void cmdLoop;

  // 4. 登录
  const sms = new SmsLinkClient(token);
  if (!manual) {
    try {
      await runAutoPhoneLogin(page, site, sms, status);
    } catch (err) {
      console.error(`[login] 自动机械流失败(可 --manual 人工接管): ${String(err?.message ?? err).split('\n')[0]}`);
    }
  } else {
    console.log(`[login] 手动模式:经 cmd.json 驱动登录,完成后 touch ${dir}/done.flag`);
    for (let i = 0; i < 360 && !existsSync(`${dir}/done.flag`); i++) await page.waitForTimeout(5_000); // 30 分钟
  }

  // 5. 校验登录态 → 导出凭证 → 回收入池
  let loggedIn = await loggedInGeneric(page, site);
  if (!loggedIn && existsSync(`${dir}/done.flag`)) {
    console.log('[login] done.flag 在场,按画面人工判定为已登录');
    loggedIn = true;
  }
  console.log(`[login] checkLogin=${loggedIn} url=${page.url().slice(0, 80)}`);
  if (!loggedIn) {
    await status('登录态校验未通过,不入池');
    console.error('[login] 登录态校验未通过——不写入账号池');
    stop.value = true;
    await page.waitForTimeout(Math.min(keepMs, 15_000)).catch(() => undefined);
    await session.release();
    process.exit(1);
  }
  const storageState = await page.context().storageState();
  const ingest = await apiFetch(`${apiBase}/api/admin/accounts/${profileId}/credentials`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ storageState, contextId: session.contextId, proxyServer: ctx.proxyServer }),
  }).then((r) => r.json());
  if (!ingest?.ok) {
    console.error(`[login] 凭证入池失败: ${JSON.stringify(ingest).slice(0, 200)}`);
    // 入池失败也要优雅释放:Context 登录态同步依赖 graceful close,下次会话才能恢复登录
    stop.value = true;
    await releaseSession();
    process.exit(1);
  }
  console.log(`[login] ✅ 凭证已入池:档案 #${profileId} 置 available(cookies=${ingest.cookies}, 出口=${ctx.proxyServer ?? '直连'})`);
  await status(`登录成功,凭证已入池(cookies=${ingest.cookies})`);
  await page.waitForTimeout(keepMs).catch(() => undefined);
  stop.value = true;
  await session.release();
  process.exit(0);
}

main().catch((e) => {
  console.error('[login] 执行异常:', e instanceof Error ? e.message : e);
  process.exit(1);
});
