import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Modest pool — single Node process, low concurrency. Bump if /api/*
  // load grows or analyze/tts requests start contending.
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export { schema };
