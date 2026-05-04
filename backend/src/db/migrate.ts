import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * One-shot migration runner. Invoke via `npm run db:migrate` after
 * `npm run db:generate` produced new SQL files in ./drizzle.
 */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  console.log('Running migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
