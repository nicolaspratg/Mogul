import { Pool } from 'pg';
import { config } from '../config';

/**
 * Shared PostgreSQL connection pool.
 * A single Pool is created per process; all modules share it via this export.
 * Connection errors are logged but do not crash the process — individual
 * query callers receive the error and handle it themselves.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected idle client error:', err.message);
});
