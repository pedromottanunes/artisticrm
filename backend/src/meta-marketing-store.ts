import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from './db.js';
import { MongoStore, MongoTx } from './mongo-store.js';
import { queueMarketingAd } from './meta-acquisition.js';

export type MarketingDB = Database | MongoStore;
export interface MarketingAd {
  ad_id: string;
  account_id: string;
  ad_name: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  creative_id: string | null;
  post_id: string | null;
  post_url: string | null;
  reference_text: string | null;
  destination: string;
  scope: 'instagram_direct' | 'other' | 'unclassified';
  checked_at: string;
  creative_checked_at: string | null;
}
export interface MarketingControl {
  requested_days?: number;
  requested_at?: string;
  requested_from?: string;
  requested_to?: string;
  last_manual_at?: string;
  next_sync_at?: string;
  last_week_sync?: string;
  last_month_sync?: string;
  pause_until?: string;
  blocked_config?: string;
  last_error?: string;
  budget_until?: string;
  budget_used?: number;
  account_checked_at?: string;
  currency?: string;
  timezone?: string;
  backfill_cursor?: string;
  backfill_complete?: boolean;
  creative_retry_at?: string;
  failures?: number;
  report_revision?: string;
}
export const parsedJson = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

export class MarketingStore {
  constructor(
    readonly db: MarketingDB,
    readonly accountId: string,
  ) {}

  // Analytics never takes the queue/distribution write fence.
  async transaction<T>(work: (tx: Sql | MongoTx) => Promise<T>): Promise<T> {
    if (this.db.kind !== 'mongo') return this.db.transaction(work);
    const db = this.db;
    return db.client.withSession((session) =>
      session.withTransaction(() => work(new MongoTx(db.database, session)), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 10_000,
      }),
    );
  }

  async control(): Promise<MarketingControl> {
    const row =
      this.db.kind === 'mongo'
        ? await this.db.one('meta_marketing_control', { account_id: this.accountId })
        : (
            await this.db.query('SELECT data FROM meta_marketing_control WHERE account_id=$1', [
              this.accountId,
            ])
          ).rows[0];
    return parsedJson<MarketingControl>(row?.data ?? {});
  }

  async ensureControl() {
    if (this.db.kind === 'mongo') {
      await this.db
        .collection('meta_marketing_control')
        .updateOne(
          { account_id: this.accountId },
          { $setOnInsert: { data: {}, lease_id: null, lease_until: new Date(0) } },
          { upsert: true },
        );
    } else
      await this.db.query(
        `INSERT INTO meta_marketing_control(account_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [this.accountId],
      );
  }

  async claim(now: Date): Promise<string | null> {
    await this.ensureControl();
    const lease = randomUUID();
    const until = new Date(now.getTime() + 120_000);
    if (this.db.kind === 'mongo') {
      const result = await this.db.collection('meta_marketing_control').updateOne(
        {
          account_id: this.accountId,
          $or: [{ lease_id: null }, { lease_until: { $lte: now } }],
        },
        { $set: { lease_id: lease, lease_until: until } },
      );
      return result.matchedCount ? lease : null;
    }
    const result = await this.db.query(
      `UPDATE meta_marketing_control SET lease_id=$2,lease_until=$3
      WHERE account_id=$1 AND (lease_id IS NULL OR lease_until<=$4) RETURNING account_id`,
      [this.accountId, lease, until, now],
    );
    return result.rows.length ? lease : null;
  }

  async release(lease: string) {
    if (this.db.kind === 'mongo')
      await this.db
        .collection('meta_marketing_control')
        .updateOne(
          { account_id: this.accountId, lease_id: lease },
          { $set: { lease_id: null, lease_until: new Date(0) } },
        );
    else
      await this.db.query(
        'UPDATE meta_marketing_control SET lease_id=NULL,lease_until=NULL WHERE account_id=$1 AND lease_id=$2',
        [this.accountId, lease],
      );
  }

  async patch(values: Partial<MarketingControl>, lease?: string) {
    await this.ensureControl();
    if (this.db.kind === 'mongo') {
      const result = await this.db.collection('meta_marketing_control').updateOne(
        {
          account_id: this.accountId,
          ...(lease ? { lease_id: lease } : {}),
        },
        {
          $set: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [`data.${key}`, value]),
          ),
        },
      );
      if (!result.matchedCount) throw new Error('MARKETING_LEASE_LOST');
    } else {
      const result = await this.db.query(
        `UPDATE meta_marketing_control SET data=data || $2::jsonb
        WHERE account_id=$1 AND ($3::text IS NULL OR lease_id=$3) RETURNING account_id`,
        [this.accountId, JSON.stringify(values), lease ?? null],
      );
      if (!result.rows.length) throw new Error('MARKETING_LEASE_LOST');
    }
  }

  async assertLease(tx: Sql | MongoTx, lease: string, now: Date, publish = false) {
    // A write, not just a read: a stolen lease conflicts with publication of stale results.
    if (tx instanceof MongoTx) {
      const result = await tx.collection('meta_marketing_control').updateOne(
        {
          account_id: this.accountId,
          lease_id: lease,
          lease_until: { $gt: now },
        },
        {
          $set: {
            lease_until: new Date(now.getTime() + 120_000),
            ...(publish ? { 'data.report_revision': randomUUID() } : {}),
          },
        },
        { session: tx.session },
      );
      if (!result.matchedCount) throw new Error('MARKETING_LEASE_LOST');
    } else {
      const result = await tx.query(
        `UPDATE meta_marketing_control SET lease_until=$4,data=data || $5::jsonb
        WHERE account_id=$1 AND lease_id=$2 AND lease_until>$3 RETURNING account_id`,
        [
          this.accountId,
          lease,
          now,
          new Date(now.getTime() + 120_000),
          JSON.stringify(publish ? { report_revision: randomUUID() } : {}),
        ],
      );
      if (!result.rows.length) throw new Error('MARKETING_LEASE_LOST');
    }
  }

  async advance(values: Partial<MarketingControl>, lease: string, requestAt?: string) {
    // A request queued during a running sync must not be erased by that older run.
    if (this.db.kind === 'mongo') {
      await this.db.collection('meta_marketing_control').updateOne(
        {
          account_id: this.accountId,
          lease_id: lease,
          $expr: { $eq: [{ $ifNull: ['$data.requested_at', ''] }, requestAt ?? ''] },
        },
        {
          $set: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [`data.${key}`, value]),
          ),
        },
      );
    } else
      await this.db.query(
        `UPDATE meta_marketing_control SET data=data || $2::jsonb
      WHERE account_id=$1 AND lease_id=$3 AND COALESCE(data->>'requested_at','')=$4`,
        [this.accountId, JSON.stringify(values), lease, requestAt ?? ''],
      );
  }

  async request(values: Partial<MarketingControl>, now: Date): Promise<boolean> {
    await this.ensureControl();
    const cutoff = new Date(now.getTime() - 300_000).toISOString();
    if (this.db.kind === 'mongo') {
      const result = await this.db.collection('meta_marketing_control').updateOne(
        {
          account_id: this.accountId,
          $or: [
            { 'data.last_manual_at': { $exists: false } },
            { 'data.last_manual_at': { $lte: cutoff } },
          ],
        },
        {
          $set: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [`data.${key}`, value]),
          ),
        },
      );
      return result.matchedCount > 0;
    }
    return (
      (
        await this.db.query(
          `UPDATE meta_marketing_control SET data=data || $2::jsonb
      WHERE account_id=$1 AND COALESCE(data->>'last_manual_at','')<=$3 RETURNING account_id`,
          [this.accountId, JSON.stringify(values), cutoff],
        )
      ).rows.length > 0
    );
  }

  async ads(ids: string[]): Promise<MarketingAd[]> {
    const unique = [...new Set(ids)].slice(0, 1000);
    if (!unique.length) return [];
    const rows =
      this.db.kind === 'mongo'
        ? await this.db
            .collection('meta_marketing_ads')
            .find(
              { account_id: this.accountId, ad_id: { $in: unique } },
              { projection: { _id: 0, data: 1 }, maxTimeMS: 5000 },
            )
            .toArray()
        : (
            await this.db.query(
              'SELECT data FROM meta_marketing_ads WHERE account_id=$1 AND ad_id=ANY($2::text[])',
              [this.accountId, unique],
            )
          ).rows;
    return rows.map((row) => parsedJson<MarketingAd>(row.data));
  }

  async saveAd(ad: MarketingAd, lease: string, now: Date) {
    const { checked_at: _checked, creative_checked_at: _creative, ...content } = ad;
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    await this.transaction(async (tx) => {
      await this.assertLease(tx, lease, now, true);
      if (tx instanceof MongoTx) {
        await tx
          .collection('meta_marketing_ads')
          .updateOne(
            { account_id: this.accountId, ad_id: ad.ad_id },
            { $set: { data: ad } },
            { upsert: true, session: tx.session },
          );
        await tx
          .collection('meta_marketing_ad_versions')
          .updateOne(
            { account_id: this.accountId, ad_id: ad.ad_id, content_hash: hash },
            { $setOnInsert: { data: content, observed_at: now } },
            { upsert: true, session: tx.session },
          );
      } else {
        await tx.query(
          `INSERT INTO meta_marketing_ads(account_id,ad_id,data) VALUES ($1,$2,$3::jsonb)
          ON CONFLICT(account_id,ad_id) DO UPDATE SET data=EXCLUDED.data`,
          [this.accountId, ad.ad_id, JSON.stringify(ad)],
        );
        await tx.query(
          `INSERT INTO meta_marketing_ad_versions(account_id,ad_id,content_hash,data,observed_at)
          VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
          [this.accountId, ad.ad_id, hash, JSON.stringify(content), now],
        );
      }
    });
  }

  async dueAds(now: Date, instagramAccountId?: string) {
    const contexts = [
      `account:${this.accountId}`,
      ...(instagramAccountId ? [`instagram:${instagramAccountId}`] : []),
    ];
    const recent = new Date(now.getTime() - 32 * 86_400_000);
    const rows =
      this.db.kind === 'mongo'
        ? await this.db
            .collection('meta_marketing_ad_jobs')
            .find(
              {
                next_attempt_at: { $lte: now },
                last_seen_at: { $gte: recent },
                contexts: { $in: contexts },
              },
              { projection: { _id: 0, ad_id: 1, attempts: 1 }, maxTimeMS: 5000 },
            )
            .sort({ next_attempt_at: 1, ad_id: 1 })
            .limit(5)
            .toArray()
        : (
            await this.db.query(
              `SELECT ad_id,attempts FROM meta_marketing_ad_jobs
          WHERE next_attempt_at<=$1 AND contexts ?| $2::text[] AND last_seen_at>=$3 ORDER BY next_attempt_at,ad_id LIMIT 5`,
              [now, contexts, recent],
            )
          ).rows;
    return rows as { ad_id: string; attempts: number }[];
  }

  async finishAd(adId: string, now: Date, error: string | null, attempts: number, lease: string) {
    const permanent =
      error &&
      ['META_OBJECT_UNAVAILABLE', 'META_REQUEST_REJECTED', 'META_OPTIONAL_PERMISSION'].includes(
        error,
      );
    const delay =
      error && !permanent
        ? [60_000, 300_000, 900_000, 3_600_000, 86_400_000][Math.min(attempts, 4)]
        : 86_400_000;
    const next = new Date(now.getTime() + delay);
    await this.transaction(async (tx) => {
      await this.assertLease(tx, lease, now);
      if (tx instanceof MongoTx)
        await tx.collection('meta_marketing_ad_jobs').updateOne(
          { ad_id: adId },
          {
            $set: {
              next_attempt_at: next,
              last_error: error,
              attempts: error ? attempts + 1 : 0,
            },
          },
          { session: tx.session },
        );
      else
        await tx.query(
          'UPDATE meta_marketing_ad_jobs SET next_attempt_at=$2,last_error=$3,attempts=$4 WHERE ad_id=$1',
          [adId, next, error, error ? attempts + 1 : 0],
        );
    });
  }

  async backfill(now: Date, lease: string) {
    const control = await this.control();
    if (control.backfill_complete) return;
    const cursor = control.backfill_cursor ?? '';
    const rows =
      this.db.kind === 'mongo'
        ? await this.db
            .collection('lead_attributions')
            .aggregate<{ source_id: string }>(
              [
                { $match: { channel: 'instagram', source_type: 'ad', source_id: { $gt: cursor } } },
                { $group: { _id: '$source_id' } },
                { $sort: { _id: 1 } },
                { $limit: 25 },
                { $project: { _id: 0, source_id: '$_id' } },
              ],
              { maxTimeMS: 5000 },
            )
            .toArray()
        : (
            await this.db.query<{ source_id: string }>(
              `SELECT DISTINCT source_id FROM lead_attributions
          WHERE channel='instagram' AND source_type='ad' AND source_id>$1 ORDER BY source_id LIMIT 25`,
              [cursor],
            )
          ).rows;
    await this.transaction(async (tx) => {
      await this.assertLease(tx, lease, now);
      for (const row of rows)
        await queueMarketingAd(tx, row.source_id, `account:${this.accountId}`, now);
    });
    await this.patch(
      { backfill_cursor: rows.at(-1)?.source_id ?? cursor, backfill_complete: rows.length < 25 },
      lease,
    );
  }

  async covered(from: string, to: string): Promise<number> {
    if (this.db.kind === 'mongo')
      return this.db
        .collection('meta_marketing_daily_coverage')
        .countDocuments(
          { account_id: this.accountId, date_start: { $gte: from, $lte: to } },
          { maxTimeMS: 5000 },
        );
    return Number(
      (
        await this.db.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM meta_marketing_daily_coverage WHERE account_id=$1 AND date_start BETWEEN $2 AND $3',
          [this.accountId, from, to],
        )
      ).rows[0].count,
    );
  }
}
