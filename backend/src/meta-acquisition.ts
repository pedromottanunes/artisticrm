import type { LeadInput } from './crm.js';
import type { Sql } from './db.js';
import { MongoTx } from './mongo-store.js';

export interface Acquisition {
  kind: 'paid' | 'organic' | 'manual';
  ad_id: string | null;
  channel_account_id: string | null;
  event_id: string;
  occurred_at: string;
  time_basis: 'provider' | 'received';
  rule_version: 1;
}

export function acquisitionFor(input: LeadInput, eventId: string, received: Date): Acquisition {
  const time = input.source_event_at ? new Date(input.source_event_at) : received;
  const validTime =
    Number.isFinite(time.getTime()) && time.getTime() <= received.getTime() + 300_000;
  return {
    kind: input.meta_attribution?.source_id ? 'paid' : input.identity ? 'organic' : 'manual',
    ad_id: input.meta_attribution?.source_id ?? null,
    channel_account_id: input.identity?.account_id ?? null,
    event_id: eventId,
    occurred_at: (validTime ? time : received).toISOString(),
    time_basis: input.source_event_at && validTime ? 'provider' : 'received',
    rule_version: 1,
  };
}

// Called inside the same transaction as the inbound attribution. No network I/O.
export async function queueMarketingAd(
  tx: Sql | MongoTx,
  adId: string | undefined,
  context: string,
  now: Date,
) {
  if (!adId || !/^[a-zA-Z0-9_-]{1,100}$/.test(adId)) return;
  if (tx instanceof MongoTx) {
    await tx.collection('meta_marketing_ad_jobs').updateOne(
      { ad_id: adId },
      {
        $set: { last_seen_at: now },
        $addToSet: { contexts: context },
        $setOnInsert: { next_attempt_at: now, attempts: 0, last_error: null },
      },
      { upsert: true, session: tx.session },
    );
  } else {
    await tx.query(
      `INSERT INTO meta_marketing_ad_jobs(ad_id,contexts,last_seen_at,next_attempt_at)
      VALUES ($1,$2::jsonb,$3,$3) ON CONFLICT(ad_id) DO UPDATE SET
      last_seen_at=EXCLUDED.last_seen_at,
      contexts=CASE WHEN meta_marketing_ad_jobs.contexts @> EXCLUDED.contexts THEN meta_marketing_ad_jobs.contexts
      ELSE meta_marketing_ad_jobs.contexts || EXCLUDED.contexts END`,
      [adId, JSON.stringify([context]), now],
    );
  }
}

export async function queueInboundMarketingAd(tx: Sql | MongoTx, input: LeadInput, now: Date) {
  if (input.identity?.provider !== 'instagram' || input.meta_attribution?.channel !== 'instagram')
    return;
  await queueMarketingAd(
    tx,
    input.meta_attribution.source_id,
    `instagram:${input.identity.account_id}`,
    now,
  );
}
