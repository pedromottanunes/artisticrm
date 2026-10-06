import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CRM, type LeadInput } from '../src/crm.js';
import { MongoOperations } from '../src/mongo-crm.js';
import { MetaMarketing, type MetaMarketingConfig } from '../src/meta-marketing.js';
import type { MarketingDB } from '../src/meta-marketing-store.js';
import { marketingPeriod } from '../src/meta-marketing-reports.js';

export async function checkMarketingOrigins(db: MarketingDB) {
  let now = new Date('2026-09-23T15:00:00Z');
  const config: MetaMarketingConfig = {
    adAccountId: 'act_123456789',
    instagramAccountId: '17841400000001',
    accessToken: 'synthetic-marketing-read-only-token',
    graphApiVersion: 'v26.0',
  };
  const crm = db.kind === 'mongo' ? new MongoOperations(db, () => now) : new CRM(db, () => now);
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(url.hostname, 'graph.facebook.com');
    assert.equal(init?.redirect, 'error');
    assert.ok(!url.searchParams.has('access_token'));
    assert.doesNotMatch(
      url.searchParams.get('fields') ?? '',
      /image_url|thumbnail|video_url|previews/,
    );
    const node = url.pathname.split('/').at(-1);
    if (node === config.adAccountId)
      return Response.json({
        id: config.adAccountId,
        currency: 'BRL',
        timezone_name: 'America/Sao_Paulo',
      });
    if (node === 'insights') {
      const range = JSON.parse(url.searchParams.get('time_range')!);
      return Response.json({
        data:
          range.since <= '2026-09-23' && range.until >= '2026-09-23'
            ? [
                ['111', '20'],
                ['222', '80'],
                ['333', '10'],
              ].map(([ad_id, spend]) => ({
                date_start: '2026-09-23',
                date_stop: '2026-09-23',
                account_id: '123456789',
                account_currency: 'BRL',
                campaign_id: '888',
                campaign_name: 'Campanha clínica',
                adset_id: `set-${ad_id}`,
                adset_name: 'Conjunto',
                ad_id,
                ad_name: `Anúncio ${ad_id}`,
                spend,
                clicks: '10',
                impressions: '100',
              }))
            : [],
      });
    }
    if (['111', '222', '333'].includes(node!))
      return Response.json({
        id: node,
        account_id: '123456789',
        name: `Nome real ${node}`,
        campaign: { id: '888', name: 'Campanha clínica' },
        adset: {
          id: `set-${node}`,
          name: 'Conjunto local',
          destination_type: node === '222' ? 'WHATSAPP' : 'INSTAGRAM_DIRECT',
        },
        creative: { id: `creative-${node}` },
      });
    return Response.json({
      id: node,
      title: 'Resultado Carlos',
      effective_instagram_media_id: '555',
      instagram_permalink_url: 'https://www.instagram.com/p/CARLOS/?tracking=remove',
      image_url: 'https://never-download.example/image.jpg',
    });
  };
  const lead = (sender: string, ad?: string): LeadInput => ({
    name: 'Lead de teste',
    unit: 'Teste',
    interest: '',
    source: ad ? 'Meta Ads' : 'Instagram — origem orgânica',
    source_event_at: now.toISOString(),
    identity: {
      provider: 'instagram',
      account_id: config.instagramAccountId!,
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
  const first = await crm.ingest(lead('one', '111'), 'marketing-first', null);
  const second = await crm.ingest(lead('two', '111'), 'marketing-second', null);
  const organic = await crm.ingest(lead('organic'), 'marketing-organic', null);
  await crm.ingest(lead('other', '222'), 'marketing-other', null);
  const replay = await crm.ingest(lead('one', '111'), 'marketing-first', null);
  assert.equal(replay.id, first.id);
  now = new Date(now.getTime() + 1000);
  await crm.ingest(lead('organic', '111'), 'marketing-organic-return', null);
  if (db.kind === 'mongo') {
    const stored = await db.one('opportunities', { id: organic.id });
    assert.equal(stored?.acquisition.kind, 'organic');
    assert.equal(await db.count('meta_marketing_ad_jobs'), 2);
    await db.update(
      'opportunities',
      { id: first.id },
      {
        $set: {
          consultation_status: 'ATTENDED',
          stage: 'CLOSED_WITHOUT_DATE',
          sale_completed_at: now,
          total_value_cents: 100_000,
          contract_status: 'signed',
          open: false,
        },
      },
    );
    await db.insert('appointments', {
      id: randomUUID(),
      opportunity_id: second.id,
      starts_at: now,
      status: 'scheduled',
    });
  } else {
    const stored = (
      await db.query('SELECT acquisition FROM opportunities WHERE id=$1', [organic.id])
    ).rows[0];
    assert.equal((stored.acquisition as { kind: string }).kind, 'organic');
    assert.equal(
      Number(
        (await db.query('SELECT COUNT(*) AS count FROM meta_marketing_ad_jobs')).rows[0].count,
      ),
      2,
    );
    await db.query(
      `UPDATE opportunities SET consultation_status='ATTENDED',stage='CLOSED_WITHOUT_DATE',sale_completed_at=$2,total_value_cents=100000,contract_status='signed' WHERE id=$1`,
      [first.id, now],
    );
    const actor = (await db.query('SELECT id FROM users LIMIT 1')).rows[0];
    await db.query(
      `INSERT INTO appointments(id,opportunity_id,starts_at,unit,status,created_by) VALUES ($1,$2,$3,'Teste','scheduled',$4)`,
      [randomUUID(), second.id, now, actor.id],
    );
  }
  const disabled = new MetaMarketing(db, undefined, async () => {
    throw new Error('must not call Meta');
  });
  assert.deepEqual(await disabled.names(['111']), []);
  assert.deepEqual(await disabled.run(), { rows_synced: 0 });

  const marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.requestSync({ from: '2026-09-23', to: '2026-09-23' });
  assert.equal(calls.length, 0);
  await marketing.run();
  await marketing.run(); // Enrich the zero-lead ad discovered in Insights.
  assert.equal(calls.filter((path) => path.endsWith('/111')).length, 1);
  const beforeReads = calls.length;
  const names = await marketing.names(['111', '111']);
  assert.equal(names[0].ad_name, 'Nome real 111');
  assert.equal(names[0].post_url, 'https://www.instagram.com/p/CARLOS/');
  assert.doesNotMatch(JSON.stringify(names), /never-download|image_url|thumbnail/);
  const report = await marketing.report('2026-09-23', '2026-09-23');
  assert.equal(calls.length, beforeReads);
  assert.equal(report.coverage_complete, true);
  assert.equal(report.spend, 110);
  assert.equal(report.eligible_spend, 30); // Includes eligible ads without conversions.
  assert.equal(report.cpl, 15); // 30 / 2 eligible acquisitions, not 110 / all Instagram contacts.
  assert.equal(report.identified_paid_leads, 3);
  assert.equal(report.unattributed_or_organic_leads, 1);
  const ad = report.ads.find((row) => row.ad_id === '111')!;
  assert.equal(ad.attributed_leads, 2);
  assert.equal(ad.scheduled, 1);
  assert.equal(ad.attended, 1); // Manual attendance without a scheduled appointment remains valid.
  assert.equal(ad.sales, 1);
  assert.equal(ad.sales_value, 1000);
  assert.equal(ad.roas, 50);
  assert.equal(report.ads.find((row) => row.ad_id === '222')!.cpl, null);
  assert.equal(report.campaigns[0].reach, null);
  const readAds = marketing.store.ads.bind(marketing.store);
  try {
    marketing.store.ads = async (ids) => {
      const result = await readAds(ids);
      await marketing.store.patch({ report_revision: 'concurrent-publication' });
      return result;
    };
    const duringSync = await marketing.report('2026-09-23', '2026-09-23');
    assert.equal(duringSync.coverage_complete, false);
    assert.equal(duringSync.cpl, null);
  } finally {
    marketing.store.ads = readAds;
  }
  const leads = await marketing.leads('2026-09-23', '2026-09-23', '111');
  assert.deepEqual(leads.items.map((row) => row.id).sort(), [first.id, second.id].sort());
  assert.equal(leads.next_cursor, null);
  assert.equal(
    (await marketing.leads('2026-09-23', '2026-09-23', '111', leads.items[0].id)).items.length,
    1,
  );
  assert.equal((await marketing.leads('2026-09-22', '2026-09-22', '111')).items.length, 0);
  const partial = await marketing.report('2026-09-22', '2026-09-23');
  assert.equal(partial.coverage_complete, false);
  assert.equal(partial.cpl, null);
  await marketing.run();
  assert.equal(calls.length, beforeReads); // Idle tick and repeated reads do not hit the API.

  // Reopening a sale must remove it from the current funnel; missing amounts aren't zero revenue.
  if (db.kind === 'mongo')
    await db.update('opportunities', { id: first.id }, { $set: { total_value_cents: null } });
  else await db.query('UPDATE opportunities SET total_value_cents=NULL WHERE id=$1', [first.id]);
  const missing = (await marketing.report('2026-09-23', '2026-09-23')).ads.find(
    (row) => row.ad_id === '111',
  )!;
  assert.equal(missing.sales_value, null);
  assert.equal(missing.roas, null);
  if (db.kind === 'mongo')
    await db.update('opportunities', { id: first.id }, { $set: { stage: 'FOLLOW_UP' } });
  else await db.query("UPDATE opportunities SET stage='FOLLOW_UP' WHERE id=$1", [first.id]);
  assert.equal(
    (await marketing.report('2026-09-23', '2026-09-23')).ads.find((row) => row.ad_id === '111')!
      .sales,
    0,
  );

  // A rate-limit pause survives constructing a fresh worker (e.g. Render restart).
  let limitedCalls = 0;
  const limited: typeof fetch = async () => {
    limitedCalls++;
    return new Response(null, { status: 429, headers: { 'retry-after': '1800' } });
  };
  await assert.rejects(new MetaMarketing(db, config, limited, () => now).sync(1), {
    code: 'META_MARKETING_SYNC_FAILED',
  });
  await assert.rejects(new MetaMarketing(db, config, limited, () => now).run(), {
    code: 'META_MARKETING_SYNC_FAILED',
  });
  assert.equal(limitedCalls, 1);
  assert.equal((await marketing.report('2026-09-23', '2026-09-23')).spend, 110);

  // Lease serialization protects both data and the durable request budget.
  await marketing.store.patch({ pause_until: '', requested_from: '', requested_to: '' });
  const lease = await marketing.store.claim(now);
  assert.ok(lease);
  assert.deepEqual(await new MetaMarketing(db, config, limited, () => now).sync(1), {
    rows_synced: 0,
  });
  assert.equal(limitedCalls, 1);
  await marketing.store.patch({ requested_at: 'new-request', requested_from: '2026-09-01' });
  await marketing.store.advance({ requested_from: '' }, lease!, 'older-request');
  assert.equal((await marketing.store.control()).requested_from, '2026-09-01');
  await marketing.store.release(lease!);
  const nextLease = await marketing.store.claim(now);
  await assert.rejects(marketing.store.saveAd(names[0], lease!, now), /LEASE_LOST/);
  await marketing.store.release(nextLease!);
  assert.ok(!JSON.stringify(await marketing.status()).includes(config.accessToken));

  // Budget and access failures survive a process restart without hammering Meta.
  await marketing.store.patch({
    budget_until: new Date(now.getTime() + 3_600_000).toISOString(),
    budget_used: 120,
    pause_until: '',
  });
  await assert.rejects(new MetaMarketing(db, config, limited, () => now).sync(1), {
    code: 'META_MARKETING_SYNC_FAILED',
  });
  assert.equal(limitedCalls, 1);
  await marketing.store.patch({ budget_used: 0 });
  let authCalls = 0;
  const unauthorized: typeof fetch = async () => {
    authCalls++;
    return Response.json({ error: { code: 190, message: config.accessToken } }, { status: 400 });
  };
  await assert.rejects(new MetaMarketing(db, config, unauthorized, () => now).sync(1));
  await assert.rejects(new MetaMarketing(db, config, unauthorized, () => now).sync(1));
  assert.equal(authCalls, 1);
  assert.ok(!JSON.stringify(await marketing.status()).includes(config.accessToken));
  now = new Date(now.getTime() + 301_000);
  const queued = await Promise.all(
    Array.from({ length: 4 }, () => marketing.requestSync({ days: 1 })),
  );
  assert.equal(queued.filter((result) => !result.already_requested).length, 1);
  assert.equal((await marketing.store.control()).blocked_config, '');
  let usageCalls = 0;
  const pressured: typeof fetch = async () => {
    usageCalls++;
    return Response.json(
      { data: [] },
      { headers: { 'x-app-usage': JSON.stringify({ call_count: 85 }) } },
    );
  };
  await new MetaMarketing(db, config, pressured, () => now).sync(1);
  await assert.rejects(new MetaMarketing(db, config, pressured, () => now).sync(1));
  assert.equal(usageCalls, 1);

  const period = marketingPeriod('2026-09-23', '2026-09-23', 'America/Sao_Paulo', now);
  assert.equal(period.start.toISOString(), '2026-09-23T03:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-09-24T03:00:00.000Z');
}
