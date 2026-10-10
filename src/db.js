// Database access.
//  - DATABASE_URL=postgres://...   -> Supabase Postgres (or any Postgres) via `pg`
//  - DATABASE_URL=pglite:./data/db -> embedded Postgres (PGlite) for a zero-setup local demo
// Both expose the same tiny API: query(sql, params) -> { rows }, and tx(fn).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL || 'pglite:./data/db';

// NUMERIC and DATE come back as plain strings: no float rounding, no timezone shifts.
const NUMERIC = 1700, DATE = 1082, INT8 = 20;

let impl;

if (url.startsWith('pglite:')) {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = url.slice('pglite:'.length);
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir, { parsers: { [NUMERIC]: v => v, [DATE]: v => v, [INT8]: v => Number(v) } });
  await pg.waitReady;
  let chain = Promise.resolve();           // PGlite is single-connection: serialise transactions
  impl = {
    kind: 'pglite',
    query: (sql, params = []) => pg.query(sql, params),
    exec: sql => pg.exec(sql),
    tx: fn => {
      const run = chain.then(() => pg.transaction(t => fn({ query: (s, p = []) => t.query(s, p) })));
      chain = run.catch(() => {});
      return run;
    },
  };
} else {
  const pgmod = await import('pg');
  const pgLib = pgmod.default;
  pgLib.types.setTypeParser(NUMERIC, v => v);
  pgLib.types.setTypeParser(DATE, v => v);
  pgLib.types.setTypeParser(INT8, v => Number(v));
  const pool = new pgLib.Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
    max: 10,
  });
  impl = {
    kind: 'postgres',
    query: (sql, params = []) => pool.query(sql, params),
    exec: sql => pool.query(sql),
    tx: async fn => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const r = await fn({ query: (s, p = []) => c.query(s, p) });
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
  };
}

export const db = impl;

export async function migrate() {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await db.exec(sql);
}

// Multi-row insert in chunks. rows = array of objects with the same keys.
export async function bulkInsert(q, table, rows, chunk = 400) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map(r => '(' + cols.map(c => { params.push(r[c] ?? null); return '$' + params.length; }).join(',') + ')');
    await q.query(`insert into ${table} (${cols.join(',')}) values ${values.join(',')}`, params);
  }
}
