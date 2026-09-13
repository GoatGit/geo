import { createDb } from './client';
import { runMigrations } from './migrator';
import { ensurePartitions } from './partitions';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const command = process.argv[2] ?? 'migrate';
const { pool } = createDb(databaseUrl, 2);

try {
  if (command === 'migrate') {
    const applied = await runMigrations(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
    const parts = await ensurePartitions(pool);
    console.log(parts.length ? `partitions created: ${parts.join(', ')}` : 'partitions up to date');
  } else if (command === 'partitions') {
    const parts = await ensurePartitions(pool);
    console.log(parts.length ? `partitions created: ${parts.join(', ')}` : 'partitions up to date');
  } else {
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
