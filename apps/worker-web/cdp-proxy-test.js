const { chromium } = require('playwright-core');
const cdp = process.argv[2], proxy = process.argv[3];
(async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] || await browser.newContext();
  // 直接在已有 context 上测试网络:通过 CDP 给页面设置代理不可行;改为在沙箱内发 fetch 经代理
  // 用 CDP 的 Fetch 域太复杂——改用 page.evaluate 里经代理的 fetch 不可能(浏览器代理是全局的)
  // 正确验证:创建带代理的新 context(CDP 浏览器级代理已由 InitBrowser 设置;本地仅验证连通性)
  const page = ctx.pages()[0] || await ctx.newPage();
  // 沙箱内直接 TCP 到代理端口测连通(白名单生效与否)
  const r = await page.evaluate(async ({ proxyHost, proxyPort }) => {
    try {
      const res = await fetch(`http://${proxyHost}:${proxyPort}/`, { signal: AbortSignal.timeout(8000) });
      return 'reachable: HTTP ' + res.status;
    } catch (e) {
      return 'connect: ' + (e.message || String(e)).slice(0, 80);
    }
  }, { proxyHost: proxy.split(':')[0], proxyPort: Number(proxy.split(':')[1]) });
  console.log('proxy tcp from sandbox:', r);
  await browser.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 100)); process.exit(1); });
