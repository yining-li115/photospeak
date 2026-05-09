import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Pool sized for a single Node process on a small LAS. Idle
  // connections are cheap (PG only allocates the per-connection
  // working memory while the connection is actively running a
  // statement), so this bump from 10 → 15 doesn't meaningfully
  // change RAM at rest. Bump again to 20-30 once on 2c4g+ or
  // once a worker process (P2) is also pulling from the same DB.
  // pgbouncer (also part of P6) is deferred — it's a separate
  // process and the LAS is currently 1c1g.
  max: 15,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export { schema };
