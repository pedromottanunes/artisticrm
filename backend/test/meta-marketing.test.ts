import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import {
  MetaMarketing,
  metaMarketingConfig,
  type MetaMarketingConfig,
  type MetaMarketingFetch,
} from '../src/meta-marketing.js';

const now = new Date('2026-09-23T15:00:00.000Z');
const config: MetaMarketingConfig = {
  accessToken: 'synthetic-marketing-token-never-sent-to-meta',
  adAccountId: 'act_1789815972431863',
  graphApiVersion: 'v26.0',
};

const insight = (
  adId: string,
  campaignId: string,
  spend: string,
  campaignName = `Campanha ${campaignId}`,
) => ({
  date_start: '2026-09-23',
  date_stop: '2026-09-23',
  account_id: '1789815972431863',
  account_name: 'Conta de teste',
  account_currency: 'BRL',
  campaign_id: campaignId,
  campaign_name: campaignName,
  adset_id: `set-${adId}`,
  adset_name: `Conjunto ${adId}`,
  ad_id: adId,
  ad_name: `Anúncio ${adId}`,
  spend,
  impressions: '100',
  reach: '80',
  clicks: '10',
  actions: [{ action_type: 'link_click', value: '8' }],
});

function paginatedFetch(calls: string[]): MetaMarketingFetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const after = new URL(url).searchParams.get('after');
    const body = after
      ? { data: [insight('ad-3', 'campaign-2', '5')] }
      : {
          data: [insight('ad-1', 'campaign-1', '10'), insight('ad-2', 'campaign-1', '20')],
          paging: { cursors: { after: 'synthetic-next-page' } },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as MetaMarketingFetch;
}

let db: Database;
let crm: CRM;

before(async () => {
  db = await openDatabase();
  await migrate(db);
  crm = new CRM(db, () => now);
  await seedDemo(crm, false);
});

beforeEach(async () => {
  await db.query(
    'TRUNCATE meta_marketing_daily_insights,meta_marketing_accounts,meta_marketing_sync_state,conversation_reads,messages,instagram_webhook_inbox,conversations,contact_identities,channel_accounts,push_records,whatsapp_inbox,claims,appointments,lead_attributions,inbound_events,audit_events,opportunities,contacts,sessions',
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10');
});

after(async () => db.close());

test('Marketing API fica desligada por padrão e configuração parcial falha fechada', () => {
  assert.equal(metaMarketingConfig({}), undefined);
  assert.throws(() => metaMarketingConfig({ META_MARKETING_ENABLED: 'true' }), /incompleta/);
});

test('sincroniza páginas, atualiza insights e não expõe credenciais no status', async () => {
  const calls: string[] = [];
  const marketing = new MetaMarketing(db, config, paginatedFetch(calls), () => now);
  assert.deepEqual(await marketing.sync(7), { rows_synced: 3 });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('after'), 'synthetic-next-page');
  assert.equal((await db.query('SELECT * FROM meta_marketing_daily_insights')).rows.length, 3);

  await marketing.sync(7);
  assert.equal((await db.query('SELECT * FROM meta_marketing_daily_insights')).rows.length, 3);
  const status = await marketing.status();
  assert.equal(status.configured, true);
  assert.equal(status.state, 'idle');
  assert.equal(status.rows_synced, 3);
  assert.ok(!JSON.stringify(status).includes(config.accessToken));
});

test('relatório separa leads associados, não associados e orgânicos sem inventar atribuição', async () => {
  const marketing = new MetaMarketing(db, config, paginatedFetch([]), () => now);
  await marketing.sync(7);
  for (const [externalId, userId, adId] of [
    ['event-ad-1', 'ig-user-1', 'ad-1'],
    ['event-ad-missing', 'ig-user-2', 'ad-not-in-insights'],
  ] as const)
    await crm.ingest(
      {
        name: 'Contato Instagram',
        interest: 'Direct do Instagram',
        unit: 'A definir',
        source: 'Meta Ads — Instagram Direct',
        source_evidence: 'Referência explícita de anúncio recebida no webhook.',
        identity: {
          provider: 'instagram',
          account_id: 'ig-business-test',
          external_user_id: userId,
        },
        meta_attribution: {
          provider: 'meta',
          channel: 'instagram',
          source_type: 'ad',
          source_id: adId,
        },
      },
      externalId,
      null,
    );
  await crm.ingest(
    {
      name: 'Contato Instagram',
      interest: 'Direct do Instagram',
      unit: 'A definir',
      source: 'Instagram — origem orgânica',
      source_evidence: 'Mensagem sem referência de anúncio.',
      identity: {
        provider: 'instagram',
        account_id: 'ig-business-test',
        external_user_id: 'ig-user-organic',
      },
    },
    'event-organic',
    null,
  );
  const laterCrm = new CRM(db, () => new Date('2026-09-23T16:00:00.000Z'));
  await laterCrm.ingest(
    {
      name: 'Contato Instagram',
      interest: 'Direct do Instagram',
      unit: 'A definir',
      source: 'Meta Ads — Instagram Direct',
      identity: {
        provider: 'instagram',
        account_id: 'ig-business-test',
        external_user_id: 'ig-user-1',
      },
      meta_attribution: {
        provider: 'meta',
        channel: 'instagram',
        source_type: 'ad',
        source_id: 'ad-3',
      },
    },
    'event-repeat-with-another-ad',
    null,
  );

  const report = await marketing.report('2026-09-23', '2026-09-23');
  assert.equal(report.spend, 35);
  assert.equal(report.instagram_leads, 3);
  assert.equal(report.identified_paid_leads, 2);
  assert.equal(report.matched_attributed_leads, 1);
  assert.equal(report.unmatched_attributed_leads, 1);
  assert.equal(report.unattributed_or_organic_leads, 1);
  assert.equal(report.cpl, 35);
  assert.equal(
    report.campaigns.find((row) => row.campaign_id === 'campaign-1')?.attributed_leads,
    1,
  );
  assert.equal(
    report.campaigns.find((row) => row.campaign_id === 'campaign-2')?.attributed_leads,
    0,
  );
  await assert.rejects(() => marketing.report('2026-08-01', '2026-09-23'), {
    code: 'INVALID_PERIOD',
  });
});

test('rotas de Marketing API são exclusivas da gestão', async () => {
  const { app } = await buildApp(db, {
    metaMarketing: config,
    metaMarketingFetch: paginatedFetch([]),
    clock: () => now,
    reconcile: false,
  });
  try {
    const login = async (email: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-artisti-client': 'web' },
        payload: { email, password: DEMO_PASSWORD },
      });
      return {
        cookie: `artisti_session=${response.cookies[0].value}`,
        'x-artisti-client': 'web',
      };
    };
    const manager = await login('cadu@demo.artisti.local');
    const attendant = await login('vanessa@demo.artisti.local');
    assert.equal(
      (await app.inject({ url: '/api/v1/meta-marketing/status', headers: attendant })).statusCode,
      403,
    );
    const synced = await app.inject({
      method: 'POST',
      url: '/api/v1/meta-marketing/sync',
      headers: manager,
      payload: { days: 7 },
    });
    assert.equal(synced.statusCode, 200);
    const report = await app.inject({
      url: '/api/v1/reports/meta-ads?from=2026-09-23&to=2026-09-23',
      headers: manager,
    });
    assert.equal(report.statusCode, 200);
    assert.ok(!report.body.includes(config.accessToken));
  } finally {
    await app.close();
  }
});

test('nova sincronizacao substitui o periodo e relatorio isola a conta configurada', async () => {
  let hasRows = true;
  const request: MetaMarketingFetch = (async () =>
    new Response(
      JSON.stringify({ data: hasRows ? [insight('ad-current', 'campaign-current', '12')] : [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as MetaMarketingFetch;
  const marketing = new MetaMarketing(db, config, request, () => now);
  await marketing.sync(1);

  await db.query(
    `INSERT INTO meta_marketing_accounts(account_id,account_name,currency,status)
     VALUES ('act_other','Outra conta','BRL','active')`,
  );
  await db.query(
    `INSERT INTO meta_marketing_daily_insights(
       account_id,date_start,date_stop,campaign_id,adset_id,ad_id,currency,spend
     ) VALUES ('act_other','2026-09-23','2026-09-23','campaign-other','set-other','ad-other','BRL',999)`,
  );
  const isolated = await marketing.report('2026-09-23', '2026-09-23');
  assert.equal(isolated.spend, 12);
  assert.equal(isolated.campaigns.length, 1);

  hasRows = false;
  await marketing.sync(1);
  const remaining = (
    await db.query<{ account_id: string }>(
      'SELECT account_id FROM meta_marketing_daily_insights ORDER BY account_id',
    )
  ).rows;
  assert.deepEqual(remaining, [{ account_id: 'act_other' }]);
  assert.equal((await marketing.report('2026-09-23', '2026-09-23')).spend, 0);
});
