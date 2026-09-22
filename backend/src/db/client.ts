import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const configuredPoolMax = Number(process.env.DB_POOL_MAX ?? 5);
const poolMax =
  Number.isInteger(configuredPoolMax) && configuredPoolMax > 0
    ? configuredPoolMax
    : 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Conservative default for the current 1c1g host. Configure per process;
  // when scaling horizontally, keep the aggregate below PostgreSQL's limit.
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});

export const db = drizzle(pool, { schema });
export { schema };

export async function checkDatabase(): Promise<void> {
  await pool.query('select 1');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
