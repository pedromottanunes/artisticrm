import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { protectLegacySqlReceipts } from './command-fingerprint.js';

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
      '007_central_metrics.sql',
      '008_meta_attribution.sql',
      '009_reports.sql',
      '010_sales_qualification.sql',
      '011_weighted_distribution.sql',
      '012_compact_queue_positions.sql',
      '013_multichannel_messaging.sql',
      '014_meta_marketing.sql',
      '015_channel_backfill.sql',
      '016_outbound_send_recovery.sql',
      '017_instagram_profile.sql',
      '018_instagram_lead_details.sql',
      '019_consultation_outcomes_and_sales.sql',
      '020_new_lead_status.sql',
      '022_message_shortcuts.sql',
      '023_instagram_comments.sql',
      '024_chat_efficiency.sql',
      '025_private_reply_recovery.sql',
      '026_receipt_security.sql',
      '027_agenda_paging.sql',
      '028_lead_lists.sql',
      '029_instagram_prospects.sql',
      '030_prospect_profile_retries.sql',
      '031_marketing_origin.sql',
      '032_lead_notification_mutes.sql',
      '033_consecutive_queue_weights.sql',
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
      if (version === '026') await protectLegacySqlReceipts(tx);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
  });
}
