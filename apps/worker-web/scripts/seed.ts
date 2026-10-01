import { createDb } from '@geo/db';
import { WEB_ENGINES } from '@geo/shared';

/**
 * dev 种子:每引擎 2 个模拟账号档案(健康分 100),支撑 mock 全链路调度。
 * 生产环境账号供给为独立运营流程(docs/04 §3.1 生命周期),不使用本脚本。
 */
async function seed() {
  const { pool } = createDb(process.env.DATABASE_URL ?? 'postgres://geo:geo_dev@localhost:5432/geo');
  let n = 0;
  for (const engine of WEB_ENGINES) {
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `insert into account_profiles (engine, surface, fingerprint, proxy_hint, context_ref, health_score, status)
         values ($1, 'web', $2, $3, $4, 100, 'available')
         on conflict do nothing`,
        [
          engine,
          JSON.stringify({ ua: `Mozilla/5.0 GeoLensMock/${engine}${i}`, viewport: '1366x768', locale: 'zh-CN' }),
          `residential:mock:${engine}:${i}`,
          `mock-context-${engine}-${i}`,
        ],
      );
      n++;
    }
  }
  console.log(`seeded ${n} mock account profiles`);
  await pool.end();
}

void seed();
