import type { EngineId, Surface } from '@geo/shared';
import type { AdapterHealth, EngineAdapter } from './types';

/** 适配器注册表:按 引擎×端 解析;同引擎多版本可并存(灰度切换,docs/04 §2.1)。 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, EngineAdapter>();

  register(adapter: EngineAdapter): void {
    const key = this.keyOf(adapter.engine, adapter.surface);
    this.adapters.set(key, adapter);
  }

  get(engine: EngineId, surface: Surface = 'web'): EngineAdapter {
    const adapter = this.adapters.get(this.keyOf(engine, surface));
    if (!adapter) {
      throw new Error(`no adapter registered for ${engine}/${surface}`);
    }
    return adapter;
  }

  list(): EngineAdapter[] {
    return [...this.adapters.values()];
  }

  async healthCheckAll(): Promise<Record<string, AdapterHealth>> {
    const out: Record<string, AdapterHealth> = {};
    for (const [key, adapter] of this.adapters) {
      out[key] = await adapter.healthCheck();
    }
    return out;
  }

  private keyOf(engine: EngineId, surface: Surface): string {
    return `${engine}:${surface}`;
  }
}
