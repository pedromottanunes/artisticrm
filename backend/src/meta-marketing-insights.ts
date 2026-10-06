import { z } from 'zod';
import { MongoTx } from './mongo-store.js';
import { MarketingClient, MarketingError } from './meta-marketing-client.js';
import type { MarketingStore } from './meta-marketing-store.js';

const id = z.string().max(100).min(1);
const rowSchema = z.object({
  date_start: z.string().date(),
  date_stop: z.string().date(),
  account_id: id,
  account_name: z.string().max(500).default(''),
  account_currency: z.string().max(10).default(''),
  campaign_id: id,
  campaign_name: z.string().max(500).default(''),
  adset_id: id,
  adset_name: z.string().max(500).default(''),
  ad_id: id,
  ad_name: z.string().max(500).default(''),
  spend: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default('0'),
  impressions: z.string().regex(/^\d+$/).default('0'),
  clicks: z.string().regex(/^\d+$/).default('0'),
});
const responseSchema = z.object({
  data: z.array(rowSchema).max(500),
  paging: z
    .object({
      next: z.string().max(16384).optional(),
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
    })
    .optional(),
});

export function decimalMicros(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(micros)) throw new MarketingError('INVALID_META_RESPONSE');
  return micros;
}
export function datesBetween(from: string, to: string) {
  const result: string[] = [];
  for (
    let day = Date.parse(`${from}T12:00:00Z`);
    day <= Date.parse(`${to}T12:00:00Z`);
    day += 86_400_000
  )
    result.push(new Date(day).toISOString().slice(0, 10));
  return result;
}

export async function syncInsights(
  store: MarketingStore,
  client: MarketingClient,
  lease: string,
  from: string,
  to: string,
  now: Date,
) {
  const all = new Map<string, z.infer<typeof rowSchema>>();
  const cursors = new Set<string>();
  let after: string | undefined;
  let complete = false;
  const fields = Object.keys(rowSchema.shape).join(',');
  for (let page = 0; page < 20; page++) {
    const response = await client.get(store.accountId + '/insights', {
      fields,
      level: 'ad',
      time_increment: '1',
      limit: '500',
      time_range: JSON.stringify({ since: from, until: to }),
      ...(after ? { after } : {}),
    });
    const parsed = responseSchema.safeParse(response.value);
    if (!parsed.success) throw new MarketingError('INVALID_META_RESPONSE');
    for (const row of parsed.data.data) {
      if (
        row.account_id !== store.accountId.replace(/^act_/, '') ||
        row.date_start < from ||
        row.date_start > to ||
        row.date_stop !== row.date_start
      )
        throw new MarketingError('INVALID_META_RESPONSE');
      decimalMicros(row.spend);
      if (![Number(row.clicks), Number(row.impressions)].every(Number.isSafeInteger))
        throw new MarketingError('INVALID_META_RESPONSE');
      all.set(`${row.date_start}:${row.ad_id}`, row);
    }
    if (all.size > 10_000) throw new MarketingError('META_SYNC_LIMIT');
    if (!parsed.data.paging?.next) {
      complete = true;
      break;
    }
    const next = parsed.data.paging.cursors?.after;
    if (!next || cursors.has(next)) throw new MarketingError('META_PAGINATION_CYCLE');
    cursors.add(next);
    after = next;
  }
  if (!complete) throw new MarketingError('META_SYNC_LIMIT');
  const rows = [...all.values()].map((row) => ({
    ...row,
    spend_micros: decimalMicros(row.spend),
    currency: row.account_currency,
    spend: Number(row.spend),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
  }));
  const ads = [...new Map(rows.map((row) => [row.ad_id, row])).values()];
  if (ads.length > 1000) throw new MarketingError('META_SYNC_LIMIT');
  const dates = datesBetween(from, to);
  const account = await store.control();
  await store.transaction(async (tx) => {
    await store.assertLease(tx, lease, now, true);
    if (tx instanceof MongoTx) {
      const existing = await tx
        .collection('meta_marketing_daily_insights')
        .find(
          {
            account_id: store.accountId,
            date_start: { $gte: from, $lte: to },
          },
          { session: tx.session, projection: { _id: 0, actions: 0 } },
        )
        .limit(10_001)
        .toArray();
      if (existing.length > 10_000) throw new MarketingError('META_SYNC_LIMIT');
      const byKey = new Map(existing.map((row) => [`${row.date_start}:${row.ad_id}`, row]));
      const changes = rows.filter((row) => {
        const prior = byKey.get(`${row.date_start}:${row.ad_id}`);
        return (
          !prior ||
          Object.entries(row).some(
            ([key, value]) =>
              !['account_id', 'account_name', 'account_currency'].includes(key) &&
              prior[key] !== value,
          )
        );
      });
      for (let offset = 0; offset < changes.length; offset += 500)
        await tx.collection('meta_marketing_daily_insights').bulkWrite(
          changes
            .slice(offset, offset + 500)
            .map(
              ({
                account_id: _account,
                account_name: _name,
                account_currency: _currency,
                ...row
              }) => ({
                updateOne: {
                  filter: {
                    account_id: store.accountId,
                    date_start: row.date_start,
                    ad_id: row.ad_id,
                  },
                  update: { $set: { ...row, updated_at: now } },
                  upsert: true,
                },
              }),
            ),
          { session: tx.session },
        );
      const removed = existing.filter((row) => !all.has(`${row.date_start}:${row.ad_id}`));
      for (let offset = 0; offset < removed.length; offset += 500)
        await tx.collection('meta_marketing_daily_insights').bulkWrite(
          removed
            .slice(offset, offset + 500)
            .map((row) => ({
              deleteOne: {
                filter: {
                  account_id: store.accountId,
                  date_start: row.date_start,
                  ad_id: row.ad_id,
                },
              },
            })),
          { session: tx.session },
        );
      await tx.collection('meta_marketing_accounts').updateOne(
        { account_id: store.accountId },
        {
          $set: {
            account_name: rows.at(-1)?.account_name ?? '',
            currency: account.currency || rows.at(-1)?.currency || '',
            timezone_name: account.timezone ?? '',
            status: 'active',
            updated_at: now,
          },
        },
        { upsert: true, session: tx.session },
      );
      if (ads.length)
        await tx.collection('meta_marketing_ad_jobs').bulkWrite(
          ads.map((row) => ({
            updateOne: {
              filter: { ad_id: row.ad_id },
              update: {
                $set: { last_seen_at: now },
                $addToSet: { contexts: `account:${store.accountId}` },
                $setOnInsert: { next_attempt_at: now, attempts: 0, last_error: null },
              },
              upsert: true,
            },
          })),
          { session: tx.session },
        );
      await tx.collection('meta_marketing_daily_coverage').bulkWrite(
        dates.map((day) => ({
          updateOne: {
            filter: { account_id: store.accountId, date_start: day },
            update: { $set: { completed_at: now } },
            upsert: true,
          },
        })),
        { session: tx.session },
      );
    } else {
      await tx.query(
        `INSERT INTO meta_marketing_accounts(account_id,account_name,currency,status)
        VALUES ($1,$2,$3,'active') ON CONFLICT(account_id) DO UPDATE SET currency=EXCLUDED.currency,status='active',updated_at=$4`,
        [
          store.accountId,
          rows.at(-1)?.account_name ?? '',
          account.currency || rows.at(-1)?.currency || '',
          now,
        ],
      );
      // Complete-window reconciliation; NOT EXISTS is safe only after every page succeeded.
      await tx.query(
        `DELETE FROM meta_marketing_daily_insights d WHERE account_id=$1 AND date_start BETWEEN $2::date AND $3::date
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS r(date_start date,ad_id text) WHERE r.date_start=d.date_start AND r.ad_id=d.ad_id)`,
        [store.accountId, from, to, JSON.stringify(rows)],
      );
      for (let offset = 0; offset < rows.length; offset += 500)
        await tx.query(
          `INSERT INTO meta_marketing_daily_insights(
          account_id,date_start,date_stop,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,currency,spend,spend_micros,impressions,clicks,updated_at)
        SELECT $1,r.date_start,r.date_start,r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_id,r.ad_name,r.currency,r.spend,r.spend_micros,r.impressions,r.clicks,$3
        FROM jsonb_to_recordset($2::jsonb) AS r(date_start date,campaign_id text,campaign_name text,adset_id text,adset_name text,ad_id text,ad_name text,currency text,spend numeric,spend_micros bigint,impressions bigint,clicks bigint)
        ON CONFLICT(account_id,date_start,ad_id) DO UPDATE SET campaign_id=EXCLUDED.campaign_id,campaign_name=EXCLUDED.campaign_name,
        adset_id=EXCLUDED.adset_id,adset_name=EXCLUDED.adset_name,ad_name=EXCLUDED.ad_name,currency=EXCLUDED.currency,spend=EXCLUDED.spend,
        spend_micros=EXCLUDED.spend_micros,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,updated_at=EXCLUDED.updated_at
        WHERE (meta_marketing_daily_insights.campaign_id,meta_marketing_daily_insights.adset_id,meta_marketing_daily_insights.currency,
          meta_marketing_daily_insights.campaign_name,meta_marketing_daily_insights.adset_name,meta_marketing_daily_insights.ad_name,
          meta_marketing_daily_insights.spend_micros,meta_marketing_daily_insights.impressions,meta_marketing_daily_insights.clicks)
          IS DISTINCT FROM (EXCLUDED.campaign_id,EXCLUDED.adset_id,EXCLUDED.currency,EXCLUDED.campaign_name,EXCLUDED.adset_name,EXCLUDED.ad_name,EXCLUDED.spend_micros,EXCLUDED.impressions,EXCLUDED.clicks)`,
          [store.accountId, JSON.stringify(rows.slice(offset, offset + 500)), now],
        );
      if (ads.length)
        await tx.query(
          `INSERT INTO meta_marketing_ad_jobs(ad_id,contexts,last_seen_at,next_attempt_at)
        SELECT r.ad_id,$2::jsonb,$3,$3 FROM jsonb_to_recordset($1::jsonb) AS r(ad_id text)
        ON CONFLICT(ad_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,
          contexts=CASE WHEN meta_marketing_ad_jobs.contexts @> EXCLUDED.contexts THEN meta_marketing_ad_jobs.contexts ELSE meta_marketing_ad_jobs.contexts || EXCLUDED.contexts END`,
          [JSON.stringify(ads), JSON.stringify([`account:${store.accountId}`]), now],
        );
      await tx.query(
        `INSERT INTO meta_marketing_daily_coverage(account_id,date_start,completed_at)
        SELECT $1,day,$3 FROM unnest($2::text[]) AS day ON CONFLICT(account_id,date_start) DO UPDATE SET completed_at=EXCLUDED.completed_at`,
        [store.accountId, dates, now],
      );
    }
  });
  return { rows_synced: rows.length };
}
