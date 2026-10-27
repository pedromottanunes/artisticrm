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
  sync_stage?: {
    id: string;
    from: string;
    to: string;
    request_at: string;
    cursor: string;
    complete: boolean;
  } | null;
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
  acquisition_backfill_cursor?: string;
  acquisition_backfill_complete?: boolean;
  creative_retry_at?: string;
  failures?: number;
  report_revision?: string;
}
export const parsedJson = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

interface HistoricalAttributionRow {
  attribution_id: string;
  opportunity_id: string;
  external_id: string;
  source_id: string | null;
  attribution_received_at: Date | string;
  opportunity_channel?: string | null;
  opportunity_acquisition?: unknown;
  opportunity_created_at?: Date | string | null;
  inbound_opportunity_id?: string | null;
  inbound_received_at?: Date | string | null;
  inbox_opportunity_id?: string | null;
  instagram_account_id?: string | null;
  event?: unknown;
}

function sourceEventAt(event: unknown) {
  try {
    const parsed = parsedJson<{ lead?: { source_event_at?: unknown } }>(event);
    return typeof parsed?.lead?.source_event_at === 'string'
      ? parsed.lead.source_event_at
      : undefined;
  } catch {
    return undefined;
  }
}

function sameInstant(...values: (Date | string | null | undefined)[]) {
  const times = values.map((value) => new Date(value ?? Number.NaN).getTime());
  return times.every(Number.isFinite) && times.every((value) => value === times[0]);
}

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
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    if (unique.length > 1000) {
      const batches: MarketingAd[] = [];
      for (let offset = 0; offset < unique.length; offset += 1000)
        batches.push(...(await this.ads(unique.slice(offset, offset + 1000))));
      return batches;
    }
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

  // One-time, bounded reconstruction for leads received before acquisition snapshots existed.
  // It only accepts an attribution tied to the exact event that created the opportunity.
  async backfillAcquisitions(
    now: Date,
    lease: string,
    from: Date,
    to: Date,
    expectedInstagramAccountId?: string,
  ) {
    const control = await this.control();
    if (control.acquisition_backfill_complete) return { scanned: 0, attributed: 0 };
    const cursor = control.acquisition_backfill_cursor ?? '';
    let rows: HistoricalAttributionRow[];
    if (this.db.kind === 'mongo') {
      const attributions = await this.db
        .collection('lead_attributions')
        .find(
          {
            channel: 'instagram',
            source_type: 'ad',
            id: { $gt: cursor },
          },
          { projection: { _id: 0 } },
        )
        .sort({ id: 1 })
        .limit(25)
        .maxTimeMS(5000)
        .toArray();
      const opportunityIds = attributions.map((row) => row.opportunity_id as string);
      const externalIds = attributions.map((row) => row.external_id as string);
      const [opportunities, inboundEvents, inboxEvents] = attributions.length
        ? await Promise.all([
            this.db
              .collection('opportunities')
              .find(
                { id: { $in: opportunityIds } },
                {
                  projection: {
                    _id: 0,
                    id: 1,
                    channel: 1,
                    acquisition: 1,
                    created_at: 1,
                  },
                },
              )
              .maxTimeMS(5000)
              .toArray(),
            this.db
              .collection('inbound_events')
              .find(
                { external_id: { $in: externalIds } },
                { projection: { _id: 0, external_id: 1, opportunity_id: 1, received_at: 1 } },
              )
              .maxTimeMS(5000)
              .toArray(),
            this.db
              .collection('instagram_webhook_inbox')
              .find(
                { event_id: { $in: externalIds } },
                {
                  projection: {
                    _id: 0,
                    event_id: 1,
                    opportunity_id: 1,
                    instagram_account_id: 1,
                    event: 1,
                  },
                },
              )
              .maxTimeMS(5000)
              .toArray(),
          ])
        : [[], [], []];
      const opportunityById = new Map(opportunities.map((row) => [row.id as string, row]));
      const inboundById = new Map(inboundEvents.map((row) => [row.external_id as string, row]));
      const inboxById = new Map(inboxEvents.map((row) => [row.event_id as string, row]));
      rows = attributions.map((attribution) => {
        const opportunity = opportunityById.get(attribution.opportunity_id as string);
        const inbound = inboundById.get(attribution.external_id as string);
        const inbox = inboxById.get(attribution.external_id as string);
        return {
          attribution_id: attribution.id as string,
          opportunity_id: attribution.opportunity_id as string,
          external_id: attribution.external_id as string,
          source_id: (attribution.source_id as string | null | undefined) ?? null,
          attribution_received_at: attribution.received_at as Date,
          opportunity_channel: (opportunity?.channel as string | undefined) ?? null,
          opportunity_acquisition: opportunity?.acquisition,
          opportunity_created_at: (opportunity?.created_at as Date | undefined) ?? null,
          inbound_opportunity_id: (inbound?.opportunity_id as string | undefined) ?? null,
          inbound_received_at: (inbound?.received_at as Date | undefined) ?? null,
          inbox_opportunity_id: (inbox?.opportunity_id as string | undefined) ?? null,
          instagram_account_id: (inbox?.instagram_account_id as string | undefined) ?? null,
          event: inbox?.event,
        };
      });
    } else {
      rows = (
        await this.db.query<HistoricalAttributionRow>(
          `SELECT a.id::text AS attribution_id,a.opportunity_id::text,a.external_id,a.source_id,
             a.received_at AS attribution_received_at,o.channel AS opportunity_channel,
             o.acquisition AS opportunity_acquisition,o.created_at AS opportunity_created_at,
             e.opportunity_id::text AS inbound_opportunity_id,e.received_at AS inbound_received_at,
             w.opportunity_id::text AS inbox_opportunity_id,w.instagram_account_id,w.event
           FROM lead_attributions a
           LEFT JOIN opportunities o ON o.id=a.opportunity_id
           LEFT JOIN inbound_events e ON e.external_id=a.external_id
           LEFT JOIN instagram_webhook_inbox w ON w.event_id=a.external_id
           WHERE a.channel='instagram' AND a.source_type='ad'
             AND a.id>COALESCE(NULLIF($1,'')::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY a.id LIMIT 25`,
          [cursor],
        )
      ).rows;
    }

    let attributed = 0;
    await this.transaction(async (tx) => {
      await this.assertLease(tx, lease, now);
      for (const row of rows) {
        const createdAt = new Date(row.opportunity_created_at ?? Number.NaN);
        if (
          row.opportunity_channel !== 'instagram' ||
          row.opportunity_acquisition != null ||
          !Number.isFinite(createdAt.getTime()) ||
          createdAt < from ||
          createdAt >= to ||
          row.inbound_opportunity_id !== row.opportunity_id ||
          row.inbox_opportunity_id !== row.opportunity_id ||
          !sameInstant(
            row.opportunity_created_at,
            row.inbound_received_at,
            row.attribution_received_at,
          ) ||
          !row.source_id ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(row.source_id) ||
          !row.instagram_account_id ||
          !/^\d+$/.test(row.instagram_account_id) ||
          (expectedInstagramAccountId && row.instagram_account_id !== expectedInstagramAccountId)
        )
          continue;
        const receivedAt = new Date(row.attribution_received_at);
        const providerAt = new Date(sourceEventAt(row.event) ?? Number.NaN);
        const useProviderTime =
          Number.isFinite(providerAt.getTime()) &&
          providerAt.getTime() <= receivedAt.getTime() + 300_000;
        const acquisition = {
          kind: 'paid',
          ad_id: row.source_id,
          channel_account_id: row.instagram_account_id,
          event_id: row.external_id,
          occurred_at: (useProviderTime ? providerAt : receivedAt).toISOString(),
          time_basis: useProviderTime ? 'provider' : 'received',
          rule_version: 1,
        };
        const updated =
          tx instanceof MongoTx
            ? await tx.collection('opportunities').updateOne(
                {
                  id: row.opportunity_id,
                  channel: 'instagram',
                  acquisition: null,
                  created_at: { $gte: from, $lt: to },
                },
                { $set: { acquisition } },
                { session: tx.session },
              )
            : await tx.query(
                `UPDATE opportunities SET acquisition=$2::jsonb
                 WHERE id=$1 AND channel='instagram' AND acquisition IS NULL
                   AND created_at>=$3 AND created_at<$4 RETURNING id`,
                [row.opportunity_id, JSON.stringify(acquisition), from, to],
              );
        if ('modifiedCount' in updated ? updated.modifiedCount : updated.rows.length) attributed++;
      }
    });
    await this.patch(
      {
        acquisition_backfill_cursor: rows.at(-1)?.attribution_id ?? cursor,
        acquisition_backfill_complete: rows.length < 25,
      },
      lease,
    );
    return { scanned: rows.length, attributed };
  }

  async firstUncovered(from: string, to: string): Promise<string | null> {
    const rows =
      this.db.kind === 'mongo'
        ? await this.db
            .collection('meta_marketing_daily_coverage')
            .find(
              { account_id: this.accountId, date_start: { $gte: from, $lte: to } },
              { projection: { _id: 0, date_start: 1 }, maxTimeMS: 5000 },
            )
            .sort({ date_start: 1 })
            .toArray()
        : (
            await this.db.query<{ date_start: string }>(
              'SELECT date_start FROM meta_marketing_daily_coverage WHERE account_id=$1 AND date_start BETWEEN $2 AND $3 ORDER BY date_start',
              [this.accountId, from, to],
            )
          ).rows;
    let expected = from;
    for (const row of rows) {
      if (row.date_start > expected) break;
      if (row.date_start === expected)
        expected = new Date(Date.parse(`${expected}T12:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10);
    }
    return expected <= to ? expected : null;
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
