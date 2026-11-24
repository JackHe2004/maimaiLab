import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

type Database = {
  query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = `
  CREATE TABLE IF NOT EXISTS catalog_cache (
    source text PRIMARY KEY,
    etag text,
    body jsonb NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS scores (
    region text NOT NULL CHECK (region IN ('usa', 'intl', 'jp', 'cn')),
    chart_id text NOT NULL,
    achievement integer NOT NULL CHECK (achievement BETWEEN 0 AND 1010000),
    dx_score integer,
    dx_score_max integer,
    rank text,
    combo text,
    sync text,
    dx_stars integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (region, chart_id),
    CHECK ((dx_score IS NULL AND dx_score_max IS NULL) OR
      (dx_score IS NOT NULL AND dx_score_max IS NOT NULL AND dx_score >= 0 AND
       dx_score_max > 0 AND dx_score <= dx_score_max))
  );
`;

async function connect(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    pool.on('error', (error) => console.error('PostgreSQL connection:', error.message));
    try {
      await pool.query(schema);
      return pool;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  const path = resolve('.data/postgres');
  await mkdir(path, { recursive: true });
  const db = await PGlite.create(path);
  try {
    await db.exec(schema);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

const shared = globalThis as typeof globalThis & { maimaiDb?: Promise<Database> };

export function database() {
  shared.maimaiDb ??= connect().catch((error) => {
    delete shared.maimaiDb;
    throw error;
  });
  return shared.maimaiDb;
}
