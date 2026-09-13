import { BrokerError, type SessionBroker, type SessionHandle, type SessionProfile } from './types';

/** Mock 会话代理:dev/CI 全链路不触网;cdpUrl 为占位(worker 走 mock 适配器,不真连)。 */
export class MockSessionBroker implements SessionBroker {
  private seq = 0;
  readonly active = new Set<string>();

  constructor(private readonly maxConcurrent = 50) {}

  async acquire(_profile: SessionProfile): Promise<SessionHandle> {
    if (this.active.size >= this.maxConcurrent) {
      throw new BrokerError('mock broker: concurrent limit reached', 429);
    }
    const id = `mock-${++this.seq}`;
    this.active.add(id);
    const handle: SessionHandle = {
      sessionId: id,
      cdpUrl: `mock://cdp/${id}`,
      imageId: 'mock-browser',
      release: async () => {
        this.active.delete(id);
      },
    };
    return handle;
  }
}
