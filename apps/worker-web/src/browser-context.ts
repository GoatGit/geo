import type { Browser, BrowserContextOptions } from 'playwright-core';
import { checkLogin, hasVisibleInput, type EngineSiteConfig } from '@geo/engine-adapters';
import type { BrowserStorageState } from '@geo/shared';

/** Login, restore verification and collection must use the same browser identity. */
export function browserContextOptions(
  fingerprint: Record<string, unknown>,
  proxyServer: string | null,
  storageState?: BrowserStorageState | null,
): BrowserContextOptions {
  const size = typeof fingerprint.viewport === 'string' ? /^(\d+)x(\d+)$/.exec(fingerprint.viewport) : null;
  const width = Number(size?.[1]), height = Number(size?.[2]);
  return {
    ...(typeof fingerprint.ua === 'string' && fingerprint.ua ? { userAgent: fingerprint.ua } : {}),
    locale: typeof fingerprint.locale === 'string' && fingerprint.locale ? fingerprint.locale : 'zh-CN',
    viewport: width > 0 && height > 0 && width <= 7680 && height <= 4320
      ? { width, height } : { width: 1366, height: 850 },
    ...(proxyServer ? { proxy: { server: `http://${proxyServer}` } } : {}),
    ...(storageState ? { storageState } : {}),
  };
}

/** Verify the exported state in an independent context before declaring login done. */
export async function verifyStoredLogin(
  browser: Browser,
  site: EngineSiteConfig,
  fingerprint: Record<string, unknown>,
  proxyServer: string | null,
  storageState: BrowserStorageState,
): Promise<BrowserStorageState | null> {
  const context = await browser.newContext(browserContextOptions(fingerprint, proxyServer, storageState));
  try {
    const page = await context.newPage();
    await page.goto(site.chatUrl, { waitUntil: 'domcontentloaded', timeout: site.navigationTimeoutMs });
    await page.waitForSelector(site.inputSelectors.join(', '), { state: 'visible', timeout: 15_000 }).catch(() => undefined);
    // Allow the site's startup authentication/device check to reject stale tokens.
    await page.waitForTimeout(2_000);
    if ((await checkLogin(page, site)).loggedIn !== true || !await hasVisibleInput(page, site)) return null;
    return await context.storageState();
  } finally {
    await context.close();
  }
}
