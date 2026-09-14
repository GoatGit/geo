import { AgentBaySessionBroker } from './agentbay-broker';
import { LocalSessionBroker } from './local-broker';
import { MockSessionBroker } from './mock-broker';
import type { SessionBroker } from './types';

export { AgentBaySessionBroker, fingerprintHash } from './agentbay-broker';
export { MockSessionBroker } from './mock-broker';
export { LocalSessionBroker, type LocalBrokerConfig } from './local-broker';
export * from './types';

export type BrowserMode = 'mock' | 'agentbay' | 'local';

export function browserModeFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserMode {
  const mode = (env.BROWSER_MODE ?? 'mock') as BrowserMode;
  return mode === 'agentbay' || mode === 'local' ? mode : 'mock';
}

/** 按 env 组装(docs/07 §1:BROWSER_MODE=mock|agentbay|local)。 */
export function createBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): SessionBroker {
  const mode = browserModeFromEnv(env);
  if (mode === 'agentbay') {
    return new AgentBaySessionBroker({
      apiEndpoint: env.AGENTBAY_API_ENDPOINT ?? 'https://agentbay.cn-shanghai.aliyuncs.com',
      apiKey: env.AGENTBAY_API_TOKEN ?? '',
      imageId: env.AGENTBAY_IMAGE_ID ?? 'browser_latest',
      regionId: env.AGENTBAY_REGION_ID,
    });
  }
  if (mode === 'local') {
    return new LocalSessionBroker({
      profileRoot: env.LOCAL_BROWSER_PROFILE_DIR ?? './infra/local-data/browser-profiles',
      channel: env.LOCAL_BROWSER_CHANNEL ?? 'chrome',
      headless: (env.LOCAL_BROWSER_HEADED ?? '') !== '1',
      idleCloseMs: Number(env.LOCAL_BROWSER_IDLE_MS ?? 120_000) || 0,
      maxConcurrent: Number(env.LOCAL_BROWSER_MAX_CONCURRENT ?? 8) || 8,
      viewerLogin: env.LOGIN_VIEWER === '1',
    });
  }
  return new MockSessionBroker();
}

/** 远程可视化登录是否启用(agentbay 天然远程;local 由 LOGIN_VIEWER 开关)。 */
export function viewerLoginFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return browserModeFromEnv(env) === 'agentbay' || env.LOGIN_VIEWER === '1';
}
