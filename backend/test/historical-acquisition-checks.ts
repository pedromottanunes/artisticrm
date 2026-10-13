import assert from 'node:assert/strict';
import { CRM, type LeadInput } from '../src/crm.js';
import { MongoOperations } from '../src/mongo-crm.js';
import { MarketingStore, type MarketingDB } from '../src/meta-marketing-store.js';

export async function checkHistoricalAcquisitionBackfill(db: MarketingDB) {
  const accountId = '17841400000001';
  let now = new Date('2026-09-30T15:00:00.000Z');
  const crm = db.kind === 'mongo' ? new MongoOperations(db, () => now) : new CRM(db, () => now);
  const lead = (sender: string, ad?: string): LeadInput => ({
    name: 'Lead historico',
    unit: 'Florianopolis',
    interest: 'Direct do Instagram',
    source: ad ? 'Meta Ads' : 'Instagram - origem organica',
    source_event_at: new Date(now.getTime() - 60_000).toISOString(),
    identity: {
      provider: 'instagram',
      account_id: accountId,
      external_user_id: sender,
    },
    ...(ad
      ? {
          meta_attribution: {
            provider: 'meta' as const,
            channel: 'instagram' as const,
            source_type: 'ad' as const,
            source_id: ad,
          },
        }
      : {}),
  });

  const outsidePeriod = await crm.ingest(
    lead('historical-outside', 'historical-outside-ad'),
    'historical-outside',
    null,
  );
  now = new Date('2026-10-02T15:00:00.000Z');
  const proven = await crm.ingest(
    lead('historical-proven', 'historical-ad'),
    'historical-first',
    null,
  );
  const returned = await crm.ingest(lead('historical-returned'), 'historical-organic', null);
  const incomplete = await crm.ingest(
    lead('historical-incomplete', 'historical-missing-inbox'),
    'historical-incomplete',
    null,
  );
  now = new Date('2026-10-02T15:01:00.000Z');
  await crm.ingest(lead('historical-returned', 'historical-return-ad'), 'historical-return', null);

  const inbox = (
    eventId: string,
    opportunityId: string,
    receivedAt = '2026-10-02T15:00:00.000Z',
  ) => ({
    event_id: eventId,
    instagram_account_id: accountId,
    event: { lead: { source_event_at: new Date(Date.parse(receivedAt) - 60_000).toISOString() } },
    received_at: new Date(receivedAt),
    processed_at: new Date(Date.parse(receivedAt) + 1000),
    attempts: 1,
    available_at: new Date(receivedAt),
    lease_id: null,
    last_error: null,
    opportunity_id: opportunityId,
    conversation_id: null,
  });
  if (db.kind === 'mongo') {
    await db.update(
      'opportunities',
      { id: { $in: [outsidePeriod.id, proven.id, returned.id, incomplete.id] } },
      { $set: { acquisition: null } },
    );
    await db.insert('instagram_webhook_inbox', inbox('historical-first', proven.id));
    await db.insert(
      'instagram_webhook_inbox',
      inbox('historical-return', returned.id, '2026-10-02T15:01:00.000Z'),
    );
    await db.insert(
      'instagram_webhook_inbox',
      inbox('historical-outside', outsidePeriod.id, '2026-09-30T15:00:00.000Z'),
    );
  } else {
    await db.query('UPDATE opportunities SET acquisition=NULL WHERE id=ANY($1::uuid[])', [
      [outsidePeriod.id, proven.id, returned.id, incomplete.id],
    ]);
    for (const row of [
      inbox('historical-first', proven.id),
      inbox('historical-return', returned.id, '2026-10-02T15:01:00.000Z'),
      inbox('historical-outside', outsidePeriod.id, '2026-09-30T15:00:00.000Z'),
    ])
      await db.query(
        `INSERT INTO instagram_webhook_inbox(
           event_id,instagram_account_id,event,received_at,processed_at,attempts,available_at,
           lease_id,last_error,opportunity_id,conversation_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          row.event_id,
          row.instagram_account_id,
          JSON.stringify(row.event),
          row.received_at,
          row.processed_at,
          row.attempts,
          row.available_at,
          row.lease_id,
          row.last_error,
          row.opportunity_id,
          row.conversation_id,
        ],
      );
  }

  const store = new MarketingStore(db, 'act_123456789');
  const backfillNow = new Date('2026-10-12T15:00:00.000Z');
  const lease = await store.claim(backfillNow);
  assert.ok(lease);
  const result = await store.backfillAcquisitions(
    backfillNow,
    lease,
    new Date('2026-10-01T03:00:00.000Z'),
    backfillNow,
    accountId,
  );
  assert.deepEqual(result, { scanned: 4, attributed: 1 });
  assert.deepEqual(
    await store.backfillAcquisitions(
      backfillNow,
      lease,
      new Date('2026-10-01T03:00:00.000Z'),
      backfillNow,
      accountId,
    ),
    { scanned: 0, attributed: 0 },
  );
  await store.release(lease);

  const acquisitions =
    db.kind === 'mongo'
      ? await db
          .collection('opportunities')
          .find(
            { id: { $in: [outsidePeriod.id, proven.id, returned.id, incomplete.id] } },
            { projection: { _id: 0, id: 1, acquisition: 1 } },
          )
          .toArray()
      : (
          await db.query<{ id: string; acquisition: unknown }>(
            'SELECT id,acquisition FROM opportunities WHERE id=ANY($1::uuid[])',
            [[outsidePeriod.id, proven.id, returned.id, incomplete.id]],
          )
        ).rows;
  const byId = new Map(acquisitions.map((row) => [row.id as string, row.acquisition]));
  assert.deepEqual(byId.get(proven.id), {
    kind: 'paid',
    ad_id: 'historical-ad',
    channel_account_id: accountId,
    event_id: 'historical-first',
    occurred_at: '2026-10-02T14:59:00.000Z',
    time_basis: 'provider',
    rule_version: 1,
  });
  assert.equal(byId.get(returned.id), null);
  assert.equal(byId.get(incomplete.id), null);
  assert.equal(byId.get(outsidePeriod.id), null);
}
