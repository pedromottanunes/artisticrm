import { reportPeriod } from './reports.js';
import { MarketingStore, type MarketingAd } from './meta-marketing-store.js';
import { datesBetween } from './meta-marketing-insights.js';
import type { MetaMarketingConfig } from './meta-marketing.js';

export function marketingDate(now: Date, timeZone = 'America/Sao_Paulo') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function shiftedDate(value: string, days: number) {
  return new Date(Date.parse(`${value}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function midnight(value: string, timeZone: string) {
  const intended = Date.parse(`${value}T00:00:00Z`);
  let estimate = intended;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(estimate))
        .map((part) => [part.type, part.value]),
    );
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const difference = intended - local;
    estimate += difference;
    if (!difference) break;
  }
  return new Date(estimate);
}
export function marketingPeriod(from: string, to: string, timeZone: string, now: Date) {
  reportPeriod({ from, to }, now);
  return { from, to, start: midnight(from, timeZone), end: midnight(shiftedDate(to, 1), timeZone) };
}

interface Counts {
  ad_id: string | null;
  leads: number;
  scheduled: number;
  attended: number;
  no_show: number;
  sales: number;
  signed: number;
  value_cents: number;
  missing_value: number;
}
interface Spend {
  ad_id: string;
  campaign_id: string;
  campaign_name: string;
  adset_name: string;
  ad_name: string;
  currency: string;
  micros: number;
  clicks: number;
  impressions: number;
}
const numeric = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);

async function cohort(
  store: MarketingStore,
  start: Date,
  end: Date,
  instagramAccountId?: string,
): Promise<Counts[]> {
  const { db } = store;
  if (db.kind === 'mongo') {
    const sale = {
      $and: [
        { $in: ['$stage', ['CLOSED_WITH_DATE', 'CLOSED_WITHOUT_DATE']] },
        { $ne: [{ $ifNull: ['$sale_completed_at', null] }, null] },
      ],
    };
    const rows = await db
      .collection('opportunities')
      .aggregate<Record<string, unknown>>(
        [
          {
            $match: {
              channel: 'instagram',
              $or: [
                {
                  'acquisition.occurred_at': { $gte: start.toISOString(), $lt: end.toISOString() },
                },
                { acquisition: null, created_at: { $gte: start, $lt: end } },
              ],
              ...(instagramAccountId
                ? {
                    $and: [
                      {
                        $or: [
                          { 'acquisition.channel_account_id': instagramAccountId },
                          { acquisition: null },
                        ],
                      },
                    ],
                  }
                : {}),
            },
          },
          {
            $lookup: {
              from: 'appointments',
              localField: 'id',
              foreignField: 'opportunity_id',
              pipeline: [
                { $match: { status: { $in: ['scheduled', 'attended', 'no_show'] } } },
                { $limit: 1 },
                { $project: { _id: 0, id: 1 } },
              ],
              as: 'bookings',
            },
          },
          {
            $group: {
              _id: { $cond: [{ $eq: ['$acquisition.kind', 'paid'] }, '$acquisition.ad_id', null] },
              leads: { $sum: 1 },
              scheduled: { $sum: { $cond: [{ $gt: [{ $size: '$bookings' }, 0] }, 1, 0] } },
              attended: { $sum: { $cond: [{ $eq: ['$consultation_status', 'ATTENDED'] }, 1, 0] } },
              no_show: { $sum: { $cond: [{ $eq: ['$consultation_status', 'NO_SHOW'] }, 1, 0] } },
              sales: { $sum: { $cond: [sale, 1, 0] } },
              signed: {
                $sum: { $cond: [{ $and: [sale, { $eq: ['$contract_status', 'signed'] }] }, 1, 0] },
              },
              value_cents: { $sum: { $cond: [sale, { $ifNull: ['$total_value_cents', 0] }, 0] } },
              missing_value: {
                $sum: {
                  $cond: [
                    { $and: [sale, { $eq: [{ $ifNull: ['$total_value_cents', null] }, null] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          { $limit: 1001 },
        ],
        { maxTimeMS: 5000 },
      )
      .toArray();
    return rows.map((row) => ({
      ad_id: row._id as string | null,
      ...Object.fromEntries(
        [
          'leads',
          'scheduled',
          'attended',
          'no_show',
          'sales',
          'signed',
          'value_cents',
          'missing_value',
        ].map((key) => [key, numeric(row, key)]),
      ),
    })) as Counts[];
  }
  const rows = (
    await db.query<Record<string, unknown>>(
      `SELECT
      CASE WHEN acquisition->>'kind'='paid' THEN acquisition->>'ad_id' ELSE NULL END AS ad_id,
      COUNT(*) AS leads,
      COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM appointments a WHERE a.opportunity_id=o.id AND a.status IN ('scheduled','attended','no_show'))) AS scheduled,
      COUNT(*) FILTER(WHERE consultation_status='ATTENDED') AS attended,
      COUNT(*) FILTER(WHERE consultation_status='NO_SHOW') AS no_show,
      COUNT(*) FILTER(WHERE stage IN ('CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE') AND sale_completed_at IS NOT NULL) AS sales,
      COUNT(*) FILTER(WHERE stage IN ('CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE') AND sale_completed_at IS NOT NULL AND contract_status='signed') AS signed,
      COALESCE(SUM(total_value_cents) FILTER(WHERE stage IN ('CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE') AND sale_completed_at IS NOT NULL),0) AS value_cents,
      COUNT(*) FILTER(WHERE stage IN ('CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE') AND sale_completed_at IS NOT NULL AND total_value_cents IS NULL) AS missing_value
      FROM opportunities o WHERE channel='instagram'
      AND ((acquisition->>'occurred_at'>=$1::text AND acquisition->>'occurred_at'<$2::text)
        OR (acquisition IS NULL AND created_at>=$1::timestamptz AND created_at<$2::timestamptz))
      AND ($3::text IS NULL OR acquisition IS NULL OR acquisition->>'channel_account_id'=$3)
      GROUP BY 1 LIMIT 1001`,
      [start.toISOString(), end.toISOString(), instagramAccountId ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    ad_id: row.ad_id as string | null,
    ...Object.fromEntries(
      [
        'leads',
        'scheduled',
        'attended',
        'no_show',
        'sales',
        'signed',
        'value_cents',
        'missing_value',
      ].map((key) => [key, numeric(row, key)]),
    ),
  })) as Counts[];
}

async function spending(store: MarketingStore, from: string, to: string): Promise<Spend[]> {
  const { db } = store;
  const rows =
    db.kind === 'mongo'
      ? await db
          .collection('meta_marketing_daily_insights')
          .aggregate<Record<string, unknown>>(
            [
              { $match: { account_id: store.accountId, date_start: { $gte: from, $lte: to } } },
              { $sort: { date_start: -1 } },
              {
                $group: {
                  _id: '$ad_id',
                  campaign_id: { $first: '$campaign_id' },
                  campaign_name: { $first: '$campaign_name' },
                  adset_name: { $first: '$adset_name' },
                  ad_name: { $first: '$ad_name' },
                  currency: { $first: '$currency' },
                  micros: {
                    $sum: {
                      $ifNull: [
                        '$spend_micros',
                        { $round: [{ $multiply: ['$spend', 1_000_000] }, 0] },
                      ],
                    },
                  },
                  impressions: { $sum: '$impressions' },
                  clicks: { $sum: '$clicks' },
                },
              },
              { $limit: 1001 },
            ],
            { maxTimeMS: 5000 },
          )
          .toArray()
      : (
          await db.query<Record<string, unknown>>(
            `SELECT ad_id,(array_agg(campaign_id ORDER BY date_start DESC))[1] AS campaign_id,
        (array_agg(campaign_name ORDER BY date_start DESC))[1] AS campaign_name,
        (array_agg(adset_name ORDER BY date_start DESC))[1] AS adset_name,(array_agg(ad_name ORDER BY date_start DESC))[1] AS ad_name,
        (array_agg(currency ORDER BY date_start DESC))[1] AS currency,
        SUM(COALESCE(spend_micros,ROUND(spend*1000000))) AS micros,SUM(clicks) AS clicks,SUM(impressions) AS impressions
        FROM meta_marketing_daily_insights WHERE account_id=$1 AND date_start BETWEEN $2::date AND $3::date GROUP BY ad_id LIMIT 1001`,
            [store.accountId, from, to],
          )
        ).rows;
  return rows.map((row) => ({
    ...row,
    ad_id: String(row.ad_id ?? row._id),
    micros: numeric(row, 'micros'),
    clicks: numeric(row, 'clicks'),
    impressions: numeric(row, 'impressions'),
  })) as Spend[];
}

export async function marketingReport(
  store: MarketingStore,
  config: MetaMarketingConfig | undefined,
  from: string,
  to: string,
  now: Date,
  page = 1,
  focusAd?: string,
) {
  const control = await store.control();
  const timeZone = control.timezone || config?.timeZone || 'America/Sao_Paulo';
  const { start, end } = marketingPeriod(from, to, timeZone, now);
  const [counts, spendRows, covered] = await Promise.all([
    cohort(store, start, end, config?.instagramAccountId),
    spending(store, from, to),
    store.covered(from, to),
  ]);
  const ids = [
    ...new Set([
      ...counts.map((row) => row.ad_id).filter((id): id is string => !!id),
      ...spendRows.map((row) => row.ad_id),
    ]),
  ];
  const limited = ids.length > 1000 || counts.length > 1000 || spendRows.length > 1000;
  const catalog = new Map((await store.ads(ids)).map((ad) => [ad.ad_id, ad]));
  // Independent bounded reads must not combine pre-sync costs with post-sync coverage.
  const consistent = (await store.control()).report_revision === control.report_revision;
  const costs = new Map(spendRows.map((row) => [row.ad_id, row]));
  const conversions = new Map(counts.map((row) => [row.ad_id, row]));
  const complete = consistent && !limited && covered === datesBetween(from, to).length;
  const rows = ids
    .slice(0, 1000)
    .map((adId) => {
      const ad = catalog.get(adId),
        cost = costs.get(adId),
        count = conversions.get(adId);
      const eligible = ad?.scope === 'instagram_direct';
      const spend = (cost?.micros ?? 0) / 1_000_000;
      const ratio = (denominator: number) =>
        complete && eligible && denominator ? spend / denominator : null;
      return {
        ad_id: adId,
        ad_name: ad?.ad_name || cost?.ad_name || `Anúncio ${adId}`,
        campaign_id: cost?.campaign_id || ad?.campaign_id || '',
        campaign_name: cost?.campaign_name || ad?.campaign_name || '',
        adset_name: ad?.adset_name || cost?.adset_name || '',
        post_id: ad?.post_id ?? null,
        post_url: ad?.post_url ?? null,
        scope: ad?.scope ?? 'unclassified',
        spend,
        currency: cost?.currency || control.currency || null,
        clicks: cost?.clicks ?? 0,
        impressions: cost?.impressions ?? 0,
        attributed_leads: count?.leads ?? 0,
        scheduled: count?.scheduled ?? 0,
        attended: count?.attended ?? 0,
        no_show: count?.no_show ?? 0,
        sales: count?.sales ?? 0,
        signed: count?.signed ?? 0,
        sales_value: count?.missing_value ? null : (count?.value_cents ?? 0) / 100,
        cpl: ratio(count?.leads ?? 0),
        cost_per_scheduled: ratio(count?.scheduled ?? 0),
        cost_per_sale: ratio(count?.sales ?? 0),
        roas:
          complete &&
          eligible &&
          spend > 0 &&
          !count?.missing_value &&
          (cost?.currency || control.currency) === 'BRL'
            ? (count?.value_cents ?? 0) / 100 / spend
            : null,
      };
    })
    .sort((a, b) => b.spend - a.spend || a.ad_id.localeCompare(b.ad_id));
  const campaigns = new Map<
    string,
    {
      campaign_id: string;
      campaign_name: string;
      currency: string;
      spend: number;
      impressions: number;
      clicks: number;
      reach: null;
      attributed_leads: number;
      cpl: number | null;
      eligible: boolean;
    }
  >();
  for (const row of rows) {
    const key = row.campaign_id || `unresolved:${row.ad_id}`;
    const campaign = campaigns.get(key) ?? {
      campaign_id: key,
      campaign_name: row.campaign_name || 'Campanha pendente',
      currency: row.currency ?? '',
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: null,
      attributed_leads: 0,
      cpl: null,
      eligible: true,
    };
    campaign.spend += row.spend;
    campaign.impressions += row.impressions;
    campaign.clicks += row.clicks;
    campaign.attributed_leads += row.attributed_leads;
    campaign.eligible &&= row.scope === 'instagram_direct';
    campaigns.set(key, campaign);
  }
  for (const row of campaigns.values())
    row.cpl =
      complete && row.eligible && row.attributed_leads ? row.spend / row.attributed_leads : null;
  const eligible = rows.filter((row) => row.scope === 'instagram_direct');
  const eligibleMicros = eligible.reduce(
    (sum, row) => sum + (costs.get(row.ad_id)?.micros ?? 0),
    0,
  );
  const eligibleLeads = eligible.reduce((sum, row) => sum + row.attributed_leads, 0);
  const paid = counts.filter((row) => row.ad_id).reduce((sum, row) => sum + row.leads, 0);
  const matched = rows
    .filter((row) => catalog.has(row.ad_id) || costs.has(row.ad_id))
    .reduce((sum, row) => sum + row.attributed_leads, 0);
  const currencies = new Set(spendRows.map((row) => row.currency).filter(Boolean));
  return {
    period: { from, to },
    timezone: timeZone,
    currency:
      currencies.size > 1
        ? 'MIXED'
        : currencies.size === 1
          ? [...currencies][0]
          : control.currency || null,
    spend: spendRows.reduce((sum, row) => sum + row.micros, 0) / 1_000_000,
    eligible_spend: eligibleMicros / 1_000_000,
    coverage_complete: complete,
    covered_days: covered,
    instagram_leads: counts.reduce((sum, row) => sum + row.leads, 0),
    identified_paid_leads: paid,
    matched_attributed_leads: matched,
    unmatched_attributed_leads: Math.max(0, paid - matched),
    unattributed_or_organic_leads: conversions.get(null)?.leads ?? 0,
    cpl:
      complete && eligibleLeads && currencies.size <= 1
        ? eligibleMicros / 1_000_000 / eligibleLeads
        : null,
    campaigns: [...campaigns.values()].slice(0, 50),
    ads: focusAd
      ? rows.filter((row) => row.ad_id === focusAd)
      : rows.slice((page - 1) * 50, page * 50),
    total: rows.length,
    page,
    page_size: 50,
    limited,
    generated_at: now.toISOString(),
    last_sync: null as string | Date | null,
  };
}

export async function cachedAds(store: MarketingStore, ids: string[]): Promise<MarketingAd[]> {
  const ads = await store.ads(ids);
  const missing = [...new Set(ids)].filter((id) => !ads.some((ad) => ad.ad_id === id)).slice(0, 20);
  if (!missing.length) return ads;
  const rows =
    store.db.kind === 'mongo'
      ? await store.db
          .collection('meta_marketing_daily_insights')
          .aggregate<Record<string, unknown>>(
            [
              { $match: { account_id: store.accountId, ad_id: { $in: missing } } },
              { $sort: { date_start: -1 } },
              { $group: { _id: '$ad_id', row: { $first: '$$ROOT' } } },
              { $replaceRoot: { newRoot: '$row' } },
              {
                $project: {
                  _id: 0,
                  ad_id: 1,
                  ad_name: 1,
                  campaign_id: 1,
                  campaign_name: 1,
                  adset_id: 1,
                  adset_name: 1,
                  updated_at: 1,
                },
              },
            ],
            { maxTimeMS: 5000 },
          )
          .toArray()
      : (
          await store.db.query<Record<string, unknown>>(
            `SELECT DISTINCT ON(ad_id) ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,updated_at
        FROM meta_marketing_daily_insights WHERE account_id=$1 AND ad_id=ANY($2::text[]) ORDER BY ad_id,date_start DESC`,
            [store.accountId, missing],
          )
        ).rows;
  for (const row of rows)
    ads.push({
      ad_id: String(row.ad_id),
      account_id: store.accountId,
      ad_name: String(row.ad_name),
      campaign_id: String(row.campaign_id),
      campaign_name: String(row.campaign_name),
      adset_id: String(row.adset_id),
      adset_name: String(row.adset_name),
      creative_id: null,
      post_id: null,
      post_url: null,
      reference_text: null,
      destination: '',
      scope: 'unclassified',
      checked_at: new Date(row.updated_at as string | Date).toISOString(),
      creative_checked_at: null,
    });
  return ads;
}

// On-demand drilldown: never include every contact in the summary response.
export async function marketingLeads(
  store: MarketingStore,
  config: MetaMarketingConfig | undefined,
  from: string,
  to: string,
  adId: string,
  after: string | undefined,
  now: Date,
) {
  const control = await store.control();
  const { start, end } = marketingPeriod(
    from,
    to,
    control.timezone || config?.timeZone || 'America/Sao_Paulo',
    now,
  );
  const account = config?.instagramAccountId;
  const rows =
    store.db.kind === 'mongo'
      ? await store.db
          .collection('opportunities')
          .aggregate<{ id: string; name: string; owner_name: string | null }>(
            [
              {
                $match: {
                  channel: 'instagram',
                  'acquisition.kind': 'paid',
                  'acquisition.ad_id': adId,
                  'acquisition.occurred_at': { $gte: start.toISOString(), $lt: end.toISOString() },
                  ...(account ? { 'acquisition.channel_account_id': account } : {}),
                  ...(after ? { id: { $gt: after } } : {}),
                },
              },
              { $sort: { id: 1 } },
              { $limit: 51 },
              {
                $lookup: {
                  from: 'contacts',
                  localField: 'contact_id',
                  foreignField: 'id',
                  as: 'contact',
                  pipeline: [{ $project: { name: 1 } }],
                },
              },
              {
                $lookup: {
                  from: 'users',
                  localField: 'owner_id',
                  foreignField: 'id',
                  as: 'owner',
                  pipeline: [{ $project: { name: 1 } }],
                },
              },
              {
                $project: {
                  _id: 0,
                  id: 1,
                  name: { $ifNull: [{ $arrayElemAt: ['$contact.name', 0] }, 'Lead'] },
                  owner_name: { $ifNull: [{ $arrayElemAt: ['$owner.name', 0] }, null] },
                },
              },
            ],
            { maxTimeMS: 5000 },
          )
          .toArray()
      : (
          await store.db.query<{ id: string; name: string; owner_name: string | null }>(
            `SELECT o.id,c.name,u.name AS owner_name
      FROM opportunities o JOIN contacts c ON c.id=o.contact_id LEFT JOIN users u ON u.id=o.owner_id
      WHERE o.channel='instagram' AND o.acquisition->>'kind'='paid' AND o.acquisition->>'ad_id'=$1
      AND o.acquisition->>'occurred_at'>=$2 AND o.acquisition->>'occurred_at'<$3
      AND ($4::text IS NULL OR o.acquisition->>'channel_account_id'=$4)
      AND ($5::uuid IS NULL OR o.id>$5::uuid) ORDER BY o.id LIMIT 51`,
            [adId, start.toISOString(), end.toISOString(), account ?? null, after ?? null],
          )
        ).rows;
  return { items: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null };
}
