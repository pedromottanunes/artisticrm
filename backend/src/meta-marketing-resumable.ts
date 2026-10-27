import { createHash, randomUUID } from 'node:crypto';
import { MongoTx } from './mongo-store.js';
import { MarketingClient, MarketingError } from './meta-marketing-client.js';
import {
  decimalMicros,
  publishInsights,
  responseSchema,
  rowSchema,
} from './meta-marketing-insights.js';
import { parsedJson, type MarketingControl, type MarketingStore } from './meta-marketing-store.js';
import type { z } from 'zod';

type Stage = NonNullable<MarketingControl['sync_stage']>;
type Insight = z.infer<typeof rowSchema>;

async function writeStage(
  store: MarketingStore,
  lease: string,
  now: Date,
  stage: Stage | null,
  rows: Insight[] = [],
  cursorKey?: string,
  reset = false,
) {
  await store.transaction(async (tx) => {
    await store.assertLease(tx, lease, now);
    if (tx instanceof MongoTx) {
      const staging = tx.collection('meta_marketing_sync_staging');
      if (reset) await staging.deleteMany({ account_id: store.accountId }, { session: tx.session });
      if (stage && rows.length)
        await staging.bulkWrite(
          rows.map((row) => ({
            updateOne: {
              filter: {
                account_id: store.accountId,
                run_id: stage.id,
                kind: 'row',
                record_key: `${row.date_start}:${row.ad_id}`,
              },
              update: { $set: { data: row } },
              upsert: true,
            },
          })),
          { session: tx.session },
        );
      if (stage && cursorKey) {
        const found = await staging.findOne(
          { account_id: store.accountId, run_id: stage.id, kind: 'cursor', record_key: cursorKey },
          { session: tx.session },
        );
        if (found) throw new MarketingError('META_PAGINATION_CYCLE');
        await staging.insertOne(
          {
            account_id: store.accountId,
            run_id: stage.id,
            kind: 'cursor',
            record_key: cursorKey,
            data: {},
          },
          { session: tx.session },
        );
      }
      await tx
        .collection('meta_marketing_control')
        .updateOne(
          { account_id: store.accountId, lease_id: lease },
          { $set: { 'data.sync_stage': stage } },
          { session: tx.session },
        );
    } else {
      if (reset)
        await tx.query('DELETE FROM meta_marketing_sync_staging WHERE account_id=$1', [
          store.accountId,
        ]);
      if (stage && rows.length)
        await tx.query(
          `INSERT INTO meta_marketing_sync_staging(account_id,run_id,kind,record_key,data)
           SELECT $1,$2,'row',r.date_start || ':' || r.ad_id,r.data
           FROM jsonb_to_recordset($3::jsonb) AS r(date_start text,ad_id text,data jsonb)
           ON CONFLICT(account_id,run_id,kind,record_key) DO UPDATE SET data=EXCLUDED.data`,
          [
            store.accountId,
            stage.id,
            JSON.stringify(
              rows.map((row) => ({ date_start: row.date_start, ad_id: row.ad_id, data: row })),
            ),
          ],
        );
      if (stage && cursorKey) {
        const inserted = await tx.query(
          `INSERT INTO meta_marketing_sync_staging(account_id,run_id,kind,record_key,data)
           VALUES($1,$2,'cursor',$3,'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING record_key`,
          [store.accountId, stage.id, cursorKey],
        );
        if (!inserted.rows.length) throw new MarketingError('META_PAGINATION_CYCLE');
      }
      await tx.query(
        `UPDATE meta_marketing_control SET data=data || $3::jsonb WHERE account_id=$1 AND lease_id=$2`,
        [store.accountId, lease, JSON.stringify({ sync_stage: stage })],
      );
    }
  });
}

export async function syncInsightsResumable(
  store: MarketingStore,
  client: MarketingClient,
  lease: string,
  from: string,
  to: string,
  requestAt: string,
  clock: () => Date,
) {
  let stage = (await store.control()).sync_stage;
  if (!stage || stage.from !== from || stage.to !== to || stage.request_at !== requestAt) {
    stage = { id: randomUUID(), from, to, request_at: requestAt, cursor: '', complete: false };
    await writeStage(store, lease, clock(), stage, [], undefined, true);
  }
  // Limit work per tick, not the total: every page is durable before the next is requested.
  for (let page = 0; page < 2 && !stage.complete; page++) {
    const response = await client.get(store.accountId + '/insights', {
      fields: Object.keys(rowSchema.shape).join(','),
      level: 'ad',
      time_increment: '1',
      limit: '250',
      time_range: JSON.stringify({ since: from, until: to }),
      ...(stage.cursor ? { after: stage.cursor } : {}),
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
    }
    const next = parsed.data.paging?.next ? parsed.data.paging.cursors?.after : undefined;
    if (parsed.data.paging?.next && !next) throw new MarketingError('META_PAGINATION_CYCLE');
    const cursorKey = next ? createHash('sha256').update(next).digest('hex') : undefined;
    stage = { ...stage, cursor: next ?? '', complete: !next };
    const unique = [
      ...new Map(parsed.data.data.map((row) => [`${row.date_start}:${row.ad_id}`, row])).values(),
    ];
    await writeStage(store, lease, clock(), stage, unique, cursorKey);
  }
  if (!stage.complete) return { rows_synced: 0, complete: false };
  const saved =
    store.db.kind === 'mongo'
      ? await store.db
          .collection('meta_marketing_sync_staging')
          .find(
            { account_id: store.accountId, run_id: stage.id, kind: 'row' },
            { projection: { _id: 0, data: 1 } },
          )
          .toArray()
      : (
          await store.db.query<{ data: unknown }>(
            "SELECT data FROM meta_marketing_sync_staging WHERE account_id=$1 AND run_id=$2 AND kind='row'",
            [store.accountId, stage.id],
          )
        ).rows;
  const result = await publishInsights(
    store,
    lease,
    from,
    to,
    clock(),
    saved.map((row) => parsedJson<Insight>(row.data)),
  );
  await writeStage(store, lease, clock(), null, [], undefined, true);
  return { ...result, complete: true };
}
