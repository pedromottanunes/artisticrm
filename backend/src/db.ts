import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  kind: 'embedded' | 'postgres';
  transaction<T>(callback: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(path = 'memory://', url?: string): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    return {
      kind: 'postgres',
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      async transaction<T>(callback: (tx: Sql) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await callback({
            query: async <R>(sql: string, params?: unknown[]) => ({
              rows: (await client.query(sql, params)).rows as R[],
            }),
          });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const embedded = await PGlite.create(path);
  return {
    kind: 'embedded',
    query: <T>(sql: string, params?: unknown[]) => embedded.query<T>(sql, params),
    transaction: (callback) => embedded.transaction((tx) => callback(tx)),
    close: () => embedded.close(),
  };
}

export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    if (db.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(7418321)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)');
    for (const file of [
      '001_initial.sql',
      '002_inbound_fingerprint.sql',
      '003_operations.sql',
      '004_whatsapp.sql',
      '005_push.sql',
      '006_lead_deletion.sql',
    ]) {
      const version = file.split('_')[0];
      const done = await tx.query('SELECT version FROM schema_migrations WHERE version=$1', [
        version,
      ]);
      if (done.rows.length) continue;
      const schema = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const statement of schema
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
  });
}
