import assert from 'node:assert/strict';
import { MetaMarketing, type MetaMarketingConfig } from '../src/meta-marketing.js';
import type { MarketingDB } from '../src/meta-marketing-store.js';

export async function checkLargeMarketingReport(db: MarketingDB) {
  const config: MetaMarketingConfig = {
    adAccountId: 'act_123456789',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  const now = new Date('2026-11-03T15:00:00Z');
  const marketing = new MetaMarketing(db, config, fetch, () => now);
  const rows = Array.from({ length: 1051 }, (_, index) => ({
    account_id: config.adAccountId,
    date_start: '2026-10-01',
    date_stop: '2026-10-01',
    campaign_id: 'campaign',
    campaign_name: 'Campanha',
    adset_id: 'set',
    adset_name: 'Conjunto',
    ad_id: `ad-${String(index).padStart(4, '0')}`,
    ad_name: `Anúncio ${index}`,
    currency: 'BRL',
    spend: 1,
    spend_micros: 1_000_000,
    impressions: 1,
    clicks: 1,
  }));
  const ads = rows.map((row) => ({
    account_id: config.adAccountId,
    ad_id: row.ad_id,
    data: { ad_id: row.ad_id, account_id: config.adAccountId, scope: 'instagram_direct' },
  }));
  if (db.kind === 'mongo') {
    await db.collection('meta_marketing_daily_insights').insertMany(rows);
    await db.collection('meta_marketing_ads').insertMany(ads);
    await db.collection('meta_marketing_daily_coverage').insertOne({
      account_id: config.adAccountId,
      date_start: '2026-10-01',
      completed_at: now,
    });
  } else {
    await db.query('INSERT INTO meta_marketing_accounts(account_id) VALUES($1)', [
      config.adAccountId,
    ]);
    await db.query(
      `INSERT INTO meta_marketing_daily_insights(account_id,date_start,date_stop,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,currency,spend,spend_micros,impressions,clicks)
       SELECT account_id,date_start,date_stop,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,currency,spend,spend_micros,impressions,clicks
       FROM jsonb_to_recordset($1::jsonb) AS r(account_id text,date_start date,date_stop date,campaign_id text,campaign_name text,adset_id text,adset_name text,ad_id text,ad_name text,currency text,spend numeric,spend_micros bigint,impressions bigint,clicks bigint)`,
      [JSON.stringify(rows)],
    );
    await db.query(
      `INSERT INTO meta_marketing_ads(account_id,ad_id,data)
       SELECT account_id,ad_id,data FROM jsonb_to_recordset($1::jsonb) AS r(account_id text,ad_id text,data jsonb)`,
      [JSON.stringify(ads)],
    );
    await db.query(
      'INSERT INTO meta_marketing_daily_coverage(account_id,date_start,completed_at) VALUES($1,$2,$3)',
      [config.adAccountId, '2026-10-01', now],
    );
  }
  const report = await marketing.report('2026-10-01', '2026-10-01', 22, undefined, 'all');
  assert.equal(report.coverage_complete, true);
  assert.equal(report.limited, false);
  assert.equal(report.total, 1051);
  assert.equal(report.spend, 1051);
  assert.equal(report.eligible_spend, 1051);
  assert.equal(report.ad_groups.all, 1051);
  assert.equal(report.ads.length, 1);
}

export async function checkLargeMarketingSync(db: MarketingDB) {
  const config: MetaMarketingConfig = {
    adAccountId: 'act_123456789',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  const now = new Date('2026-10-01T15:00:00Z');
  let calls = 0;
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/' + config.adAccountId))
      return Response.json({
        id: config.adAccountId,
        currency: 'BRL',
        timezone_name: 'America/Sao_Paulo',
      });
    calls++;
    const params = url.searchParams;
    const offset = Number(params.get('after') ?? '0');
    const count = Math.min(500, 1051 - offset);
    return Response.json({
      data: Array.from({ length: count }, (_, index) => ({
        account_id: '123456789',
        account_currency: 'BRL',
        date_start: '2026-10-01',
        date_stop: '2026-10-01',
        campaign_id: 'campaign',
        adset_id: 'set',
        ad_id: `ad-${String(offset + index).padStart(4, '0')}`,
        spend: '1',
        impressions: '1',
        clicks: '1',
      })),
      ...(offset + count < 1051
        ? {
            paging: {
              next: 'https://ignored.example/next',
              cursors: { after: String(offset + count) },
            },
          }
        : {}),
    });
  };
  const marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.requestSync({ from: '2026-10-01', to: '2026-10-01' });
  await marketing.run();
  assert.equal((await marketing.report('2026-10-01', '2026-10-01')).coverage_complete, false);
  assert.equal((await marketing.run()).rows_synced, 1051);
  assert.equal(calls, 3);
  const report = await marketing.report('2026-10-01', '2026-10-01', 22);
  assert.equal(report.total, 1051);
  assert.equal(report.spend, 1051);
  assert.equal(report.coverage_complete, true);
  assert.equal(report.ads.length, 1);
}

export async function checkResumableMarketingSync(db: MarketingDB) {
  const config: MetaMarketingConfig = {
    adAccountId: 'act_987654321',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  let now = new Date('2026-10-01T15:00:00Z');
  let failed = false;
  const requested: number[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/' + config.adAccountId))
      return Response.json({
        id: config.adAccountId,
        currency: 'BRL',
        timezone_name: 'America/Sao_Paulo',
      });
    const index = Number(url.searchParams.get('after') ?? '0');
    requested.push(index);
    if (index === 2 && !failed) {
      failed = true;
      return new Response(null, { status: 503 });
    }
    return Response.json({
      data: [
        {
          account_id: '987654321',
          account_currency: 'BRL',
          date_start: '2026-10-01',
          date_stop: '2026-10-01',
          campaign_id: 'campaign',
          adset_id: 'set',
          ad_id: `ad-${index}`,
          spend: '1',
          impressions: '1',
          clicks: '1',
        },
      ],
      ...(index < 20
        ? {
            paging: { next: 'https://ignored.example/next', cursors: { after: String(index + 1) } },
          }
        : {}),
    });
  };
  let marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.requestSync({ from: '2026-10-01', to: '2026-10-01' });
  await marketing.run();
  assert.deepEqual(requested, [0, 1]);
  assert.equal((await marketing.report('2026-10-01', '2026-10-01')).coverage_complete, false);
  assert.equal((await marketing.report('2026-10-01', '2026-10-01')).spend, 0);
  await assert.rejects(marketing.run(), { code: 'META_MARKETING_SYNC_FAILED' });
  now = new Date(now.getTime() + 120_000);
  marketing = new MetaMarketing(db, config, request, () => now);
  for (let i = 0; i < 10; i++) await marketing.run();
  const report = await marketing.report('2026-10-01', '2026-10-01');
  assert.equal(report.coverage_complete, true);
  assert.equal(report.total, 21);
  assert.equal(report.spend, 21);
  assert.equal(requested.filter((index) => index === 0).length, 1);
  assert.equal(requested.filter((index) => index === 2).length, 2);
  assert.equal((await marketing.status()).queued, false);
  assert.equal((await marketing.store.control()).sync_stage, null);
  const staged =
    db.kind === 'mongo'
      ? await db
          .collection('meta_marketing_sync_staging')
          .countDocuments({ account_id: config.adAccountId })
      : Number(
          (
            await db.query<{ count: string }>(
              'SELECT count(*) AS count FROM meta_marketing_sync_staging WHERE account_id=$1',
              [config.adAccountId],
            )
          ).rows[0].count,
        );
  assert.equal(staged, 0);
}

export async function checkAutomaticHistoricalCoverage(db: MarketingDB) {
  const config: MetaMarketingConfig = {
    adAccountId: 'act_987654321',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  const now = new Date('2026-10-09T15:00:00Z');
  const ranges: { since: string; until: string }[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/' + config.adAccountId))
      return Response.json({
        id: config.adAccountId,
        currency: 'BRL',
        timezone_name: 'America/Sao_Paulo',
      });
    ranges.push(JSON.parse(url.searchParams.get('time_range')!));
    return Response.json({ data: [] });
  };
  const marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.store.patch({ next_sync_at: new Date(now.getTime() + 3_600_000).toISOString() });
  await marketing.run();
  await marketing.run();
  assert.deepEqual(ranges, [
    { since: '2026-10-01', until: '2026-10-07' },
    { since: '2026-10-08', until: '2026-10-09' },
  ]);
  assert.equal((await marketing.report('2026-10-01', '2026-10-09')).coverage_complete, true);
  assert.equal(await marketing.store.firstUncovered('2026-10-01', '2026-10-09'), null);
}

export async function checkResumableCyclePreservesData(db: MarketingDB) {
  const config: MetaMarketingConfig = {
    adAccountId: 'act_987654321',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  const now = new Date('2026-10-01T15:00:00Z');
  const insight = (ad_id: string, spend: string) => ({
    account_id: '987654321',
    account_currency: 'BRL',
    date_start: '2026-10-01',
    date_stop: '2026-10-01',
    campaign_id: 'campaign',
    adset_id: 'set',
    ad_id,
    spend,
    impressions: '1',
    clicks: '1',
  });
  const initial = new MetaMarketing(
    db,
    config,
    async () => Response.json({ data: [insight('original', '42')] }),
    () => now,
  );
  await initial.sync(1);
  const request: typeof fetch = async (input) => {
    if (new URL(String(input)).pathname.endsWith('/' + config.adAccountId))
      return Response.json({
        id: config.adAccountId,
        currency: 'BRL',
        timezone_name: 'America/Sao_Paulo',
      });
    return Response.json({
      data: [insight('unfinished', '500')],
      paging: { next: 'https://ignored.example/next', cursors: { after: 'same-cursor' } },
    });
  };
  const marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.requestSync({ from: '2026-10-01', to: '2026-10-01' });
  await assert.rejects(marketing.run(), { code: 'META_MARKETING_SYNC_FAILED' });
  assert.equal((await marketing.status()).last_error, 'META_PAGINATION_CYCLE');
  const report = await marketing.report('2026-10-01', '2026-10-01');
  assert.equal(report.spend, 42);
  assert.equal(report.total, 1);
  assert.equal(report.ads[0].ad_id, 'original');
}
