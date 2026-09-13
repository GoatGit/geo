import { AgentBaySessionBroker } from './agentbay-broker';
import { MockSessionBroker } from './mock-broker';
import type { SessionBroker } from './types';

export { AgentBaySessionBroker, AgentBayClient, fingerprintHash } from './agentbay-broker';
export { MockSessionBroker } from './mock-broker';
export * from './types';

/** 按 env 组装(docs/07 §1:BROWSER_MODE=mock|agentbay)。 */
export function createBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): SessionBroker {
  const mode = env.BROWSER_MODE ?? 'mock';
  if (mode === 'agentbay') {
    return new AgentBaySessionBroker({
      apiEndpoint: env.AGENTBAY_API_ENDPOINT ?? 'https://agentbay.cn-shanghai.aliyuncs.com',
      apiKey: env.AGENTBAY_API_TOKEN ?? '',
      imageId: env.AGENTBAY_IMAGE_ID ?? 'browser_latest',
      regionId: env.AGENTBAY_REGION_ID,
    });
  }
  return new MockSessionBroker();
}
