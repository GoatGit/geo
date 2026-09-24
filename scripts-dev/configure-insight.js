#!/usr/bin/env node
/** 超级问卷联调用:清除 dev 库 platform_settings 的 insightAgent 行,
 *  让 resolveInsightSettings 回落到 env 引导或代码默认值(避免 DB 残留配置遮蔽)。 */
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', 'node_modules', '.pnpm', 'node_modules', 'pg'));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL || 'postgres://geo:geo_dev@localhost:15432/geo' });
(async () => {
  await pool.query("delete from platform_settings where key='insightAgent'");
  console.log('insightAgent DB row cleared (env/管理后台接管)');
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
