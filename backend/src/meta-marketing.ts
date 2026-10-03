import { z } from 'zod';
import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import { reportPeriod } from './reports.js';
import { DomainError } from './types.js';

export interface MetaMarketingConfig {
  accessToken: string;
  adAccountId: string;
  graphApiVersion: string;
  timeZone?: string;
}

export type MetaMarketingFetch = typeof fetch;

export function metaMarketingConfig(env: NodeJS.ProcessEnv): MetaMarketingConfig | undefined {
  if (env.META_MARKETING_ENABLED !== 'true') return undefined;
  const parsed = z
    .object({
      accessToken: z.string().min(20),
      adAccountId: z.string().regex(/^act_\d+$/),
      graphApiVersion: z.string().regex(/^v\d+\.\d+$/),
      timeZone: z
        .string()
        .min(3)
        .max(100)
        .default('America/Sao_Paulo')
        .refine((value) => {
          try {
            formatDate(new Date(0), value);
            return true;
          } catch {
            return false;
          }
        }),
    })
    .safeParse({
      accessToken: env.META_MARKETING_ACCESS_TOKEN,
      adAccountId: env.META_AD_ACCOUNT_ID,
      graphApiVersion: env.META_GRAPH_VERSION,
      timeZone: env.META_AD_TIMEZONE,
    });
  if (!parsed.success) throw new Error('Configuração da Marketing API incompleta ou inválida.');
  return parsed.data;
}

const actionSchema = z.object({
  action_type: z.string().max(200),
  value: z.string().max(100),
});

const insightSchema = z.object({
  date_start: z.string().date(),
  date_stop: z.string().date(),
  account_id: z.string().max(100),
  account_name: z.string().max(500).default(''),
  account_currency: z.string().max(10).default(''),
  campaign_id: z.string().max(100),
  campaign_name: z.string().max(500).default(''),
  adset_id: z.string().max(100),
  adset_name: z.string().max(500).default(''),
  ad_id: z.string().max(100),
  ad_name: z.string().max(500).default(''),
  spend: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .default('0'),
  impressions: z.string().regex(/^\d+$/).default('0'),
  reach: z.string().regex(/^\d+$/).default('0'),
  clicks: z.string().regex(/^\d+$/).default('0'),
  actions: z.array(actionSchema).max(500).default([]),
});

const insightsResponseSchema = z.object({
  data: z.array(insightSchema).max(500),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().max(16_384).optional(),
    })
    .optional(),
});

// Small clinic workloads must not consume the entire web process while syncing ads.
// Reject incomplete/oversized results before replacing any previously synced rows.
const syncLimits = {
  pages: 20,
  rows: 10_000,
  pageBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
};
async function readInsightPage(response: Response) {
  if (!response.body) throw new Error('INVALID_META_RESPONSE');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > syncLimits.pageBytes) throw new Error('META_SYNC_LIMIT');
      chunks.push(part.value);
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, size };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function formatDate(date: Date, timeZone = 'America/Sao_Paulo') {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    throw new Error('INVALID_META_TIMEZONE');
  }
}

function startOfRange(today: Date, days: number, timeZone?: string) {
  const localToday = formatDate(today, timeZone);
  const [year, month, day] = localToday.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - days + 1, 12)).toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export class MetaMarketing {
  private syncing?: Promise<{ rows_synced: number }>;

  constructor(
    private db: Database | MongoStore,
    private config?: MetaMarketingConfig,
    private request: MetaMarketingFetch = fetch,
    private clock: () => Date = () => new Date(),
  ) {}

  private async setSyncState(
    state: 'syncing' | 'idle' | 'error',
    values: { started?: Date; completed?: Date; error?: string | null; rows?: number } = {},
  ) {
    const config = this.config!;
    if (this.db.kind === 'mongo')
      await this.db.collection('meta_marketing_sync_state').updateOne(
        { account_id: config.adAccountId },
        {
          $set: {
            state,
            ...(values.started ? { last_started_at: values.started } : {}),
            ...(values.completed ? { last_completed_at: values.completed } : {}),
            ...(values.error !== undefined ? { last_error: values.error } : {}),
            ...(values.rows !== undefined ? { rows_synced: values.rows } : {}),
          },
          $setOnInsert: { account_id: config.adAccountId },
        },
        { upsert: true },
      );
    else
      await this.db.query(
        `INSERT INTO meta_marketing_sync_state(
           account_id,state,last_started_at,last_completed_at,last_error,rows_synced
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (account_id) DO UPDATE SET
           state=EXCLUDED.state,
           last_started_at=COALESCE(EXCLUDED.last_started_at,meta_marketing_sync_state.last_started_at),
           last_completed_at=COALESCE(EXCLUDED.last_completed_at,meta_marketing_sync_state.last_completed_at),
           last_error=EXCLUDED.last_error,
           rows_synced=CASE WHEN $7::boolean THEN EXCLUDED.rows_synced ELSE meta_marketing_sync_state.rows_synced END`,
        [
          config.adAccountId,
          state,
          values.started ?? null,
          values.completed ?? null,
          values.error ?? null,
          values.rows ?? 0,
          values.rows !== undefined,
        ],
      );
  }

  private async persist(rows: z.infer<typeof insightSchema>[], since: string, until: string) {
    const config = this.config!;
    if (this.db.kind === 'mongo')
      return this.db.atomic(async (tx) => {
        const updatedAt = await tx.now();
        await tx.collection('meta_marketing_daily_insights').deleteMany(
          {
            account_id: config.adAccountId,
            date_start: { $gte: since, $lte: until },
          },
          { session: tx.session },
        );
        const last = rows.at(-1);
        if (last) {
          await tx.collection('meta_marketing_accounts').updateOne(
            { account_id: config.adAccountId },
            {
              $set: {
                account_name: last.account_name,
                currency: last.account_currency,
                status: 'active',
                updated_at: updatedAt,
              },
              $setOnInsert: { account_id: config.adAccountId, timezone_name: '' },
            },
            { upsert: true, session: tx.session },
          );
        }
        for (let offset = 0; offset < rows.length; offset += 500) {
          await tx.collection('meta_marketing_daily_insights').bulkWrite(
            rows.slice(offset, offset + 500).map((row) => ({
              updateOne: {
                filter: {
                  account_id: config.adAccountId,
                  date_start: row.date_start,
                  ad_id: row.ad_id,
                },
                update: {
                  $set: {
                    date_stop: row.date_stop,
                    campaign_id: row.campaign_id,
                    campaign_name: row.campaign_name,
                    adset_id: row.adset_id,
                    adset_name: row.adset_name,
                    ad_name: row.ad_name,
                    currency: row.account_currency,
                    spend: Number(row.spend),
                    impressions: Number(row.impressions),
                    reach: Number(row.reach),
                    clicks: Number(row.clicks),
                    actions: row.actions,
                    updated_at: updatedAt,
                  },
                },
                upsert: true,
              },
            })),
            { ordered: true, session: tx.session },
          );
        }
      });

    return this.db.transaction(async (tx) => {
      await tx.query(
        `DELETE FROM meta_marketing_daily_insights
         WHERE account_id=$1 AND date_start BETWEEN $2::date AND $3::date`,
        [config.adAccountId, since, until],
      );
      const last = rows.at(-1);
      if (last) {
        await tx.query(
          `INSERT INTO meta_marketing_accounts(account_id,account_name,currency,status)
           VALUES ($1,$2,$3,'active')
           ON CONFLICT (account_id) DO UPDATE SET account_name=EXCLUDED.account_name,
             currency=EXCLUDED.currency,status='active',updated_at=clock_timestamp()`,
          [config.adAccountId, last.account_name, last.account_currency],
        );
      }
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500);
        await tx.query(
          `INSERT INTO meta_marketing_daily_insights(
             account_id,date_start,date_stop,campaign_id,campaign_name,adset_id,adset_name,
             ad_id,ad_name,currency,spend,impressions,reach,clicks,actions
           ) SELECT $1,r.date_start,r.date_stop,r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,
               r.ad_id,r.ad_name,r.account_currency,r.spend,r.impressions,r.reach,r.clicks,r.actions
             FROM jsonb_to_recordset($2::jsonb) AS r(
               date_start date,date_stop date,campaign_id text,campaign_name text,adset_id text,adset_name text,
               ad_id text,ad_name text,account_currency text,spend numeric,impressions bigint,reach bigint,clicks bigint,actions jsonb)
           ON CONFLICT (account_id,date_start,ad_id) DO UPDATE SET
             date_stop=EXCLUDED.date_stop,campaign_id=EXCLUDED.campaign_id,
             campaign_name=EXCLUDED.campaign_name,adset_id=EXCLUDED.adset_id,
             adset_name=EXCLUDED.adset_name,ad_name=EXCLUDED.ad_name,
             currency=EXCLUDED.currency,spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,
             reach=EXCLUDED.reach,clicks=EXCLUDED.clicks,actions=EXCLUDED.actions,
             updated_at=clock_timestamp()`,
          [config.adAccountId, JSON.stringify(batch)],
        );
      }
    });
  }

  private async performSync(days: number) {
    const config = this.config;
    if (!config)
      throw new DomainError('META_MARKETING_DISABLED', 'Marketing API não configurada.', 503);
    const started = this.clock();
    await this.setSyncState('syncing', { started, error: null });
    const since = startOfRange(started, days, config.timeZone);
    const until = formatDate(started, config.timeZone);
    const fields = [
      'date_start',
      'date_stop',
      'account_id',
      'account_name',
      'account_currency',
      'campaign_id',
      'campaign_name',
      'adset_id',
      'adset_name',
      'ad_id',
      'ad_name',
      'spend',
      'impressions',
      'reach',
      'clicks',
      'actions',
    ].join(',');
    const all = new Map<string, z.infer<typeof insightSchema>>();
    const cursors = new Set<string>();
    let bytes = 0;
    let complete = false;
    let after: string | undefined;
    try {
      for (let page = 0; page < syncLimits.pages; page++) {
        const params = new URLSearchParams({
          fields,
          level: 'ad',
          time_increment: '1',
          limit: '500',
          time_range: JSON.stringify({ since, until }),
        });
        if (after) params.set('after', after);
        const response = await this.request(
          `https://graph.facebook.com/${config.graphApiVersion}/${config.adAccountId}/insights?${params}`,
          {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`META_HTTP_${response.status}`);
        }
        const body = await readInsightPage(response);
        bytes += body.size;
        if (bytes > syncLimits.totalBytes) throw new Error('META_SYNC_LIMIT');
        const parsed = insightsResponseSchema.safeParse(body.value);
        if (!parsed.success) throw new Error('INVALID_META_RESPONSE');
        for (const row of parsed.data.data) {
          if (
            row.account_id !== config.adAccountId.replace(/^act_/, '') ||
            row.date_start < since ||
            row.date_start > until
          )
            throw new Error('INVALID_META_RESPONSE');
          all.set(`${row.date_start}:${row.ad_id}`, row);
        }
        if (all.size > syncLimits.rows) throw new Error('META_SYNC_LIMIT');
        const next = parsed.data.paging?.cursors?.after;
        // Cursors can exist on the last page. Only paging.next signals more data;
        // rebuild the request ourselves instead of following a credential-bearing URL.
        if (!parsed.data.paging?.next) {
          complete = true;
          break;
        }
        if (!next) throw new Error('INVALID_META_RESPONSE');
        if (cursors.has(next)) throw new Error('META_PAGINATION_CYCLE');
        cursors.add(next);
        after = next;
      }
      if (!complete) throw new Error('META_SYNC_LIMIT');
      await this.persist([...all.values()], since, until);
      await this.setSyncState('idle', {
        completed: this.clock(),
        error: null,
        rows: all.size,
      });
      return { rows_synced: all.size };
    } catch (error) {
      const code =
        error instanceof Error && /^META_HTTP_\d+$/.test(error.message)
          ? error.message
          : 'SYNC_FAILED';
      await this.setSyncState('error', { error: code });
      throw new DomainError(
        'META_MARKETING_SYNC_FAILED',
        'Não foi possível sincronizar os dados da Meta. O atendimento continua disponível.',
        502,
      );
    }
  }

  async sync(days = 7) {
    if (!this.syncing) {
      this.syncing = this.performSync(days).finally(() => {
        this.syncing = undefined;
      });
    }
    return this.syncing;
  }

  async status() {
    const config = this.config;
    if (!config)
      return {
        configured: false,
        state: 'disabled',
        last_started_at: null,
        last_completed_at: null,
        last_error: null,
        rows_synced: 0,
      };
    const state =
      this.db.kind === 'mongo'
        ? await this.db.one('meta_marketing_sync_state', { account_id: config.adAccountId })
        : (
            await this.db.query('SELECT * FROM meta_marketing_sync_state WHERE account_id=$1', [
              config.adAccountId,
            ])
          ).rows[0];
    return {
      configured: true,
      account_id: config.adAccountId,
      graph_api_version: config.graphApiVersion,
      state: state?.state ?? 'idle',
      last_started_at: state?.last_started_at ?? null,
      last_completed_at: state?.last_completed_at ?? null,
      last_error: state?.last_error ?? null,
      rows_synced: state?.rows_synced ?? 0,
    };
  }

  async report(fromInput: string, toInput: string) {
    const { from, to, start, end } = reportPeriod({ from: fromInput, to: toInput }, this.clock());
    const insights = !this.config
      ? []
      : this.db.kind === 'mongo'
        ? await this.db.many<Record<string, unknown>>('meta_marketing_daily_insights', {
            account_id: this.config.adAccountId,
            date_start: { $gte: from, $lte: to },
          })
        : (
            await this.db.query<Record<string, unknown>>(
              `SELECT * FROM meta_marketing_daily_insights
               WHERE account_id=$1 AND date_start BETWEEN $2::date AND $3::date`,
              [this.config.adAccountId, from, to],
            )
          ).rows;
    const instagramLeads =
      this.db.kind === 'mongo'
        ? await this.db.many<{ id: string }>('opportunities', {
            channel: 'instagram',
            created_at: { $gte: start, $lt: end },
          })
        : (
            await this.db.query<{ id: string }>(
              `SELECT id FROM opportunities
               WHERE channel='instagram' AND created_at >= $1::timestamptz
                 AND created_at < $2::timestamptz`,
              [start, end],
            )
          ).rows;
    const instagramLeadIds = instagramLeads.map((lead) => lead.id);
    const attributions =
      this.db.kind === 'mongo'
        ? instagramLeadIds.length
          ? await this.db.many<{
              opportunity_id: string;
              source_id: string;
              received_at: string | Date;
            }>('lead_attributions', {
              opportunity_id: { $in: instagramLeadIds },
              channel: 'instagram',
              source_type: 'ad',
              source_id: { $type: 'string' },
            })
          : []
        : (
            await this.db.query<{
              opportunity_id: string;
              source_id: string;
              received_at: string | Date;
            }>(
              `SELECT a.opportunity_id,a.source_id,a.received_at FROM lead_attributions a
               JOIN opportunities o ON o.id=a.opportunity_id
               WHERE a.channel='instagram' AND a.source_type='ad' AND a.source_id IS NOT NULL
                 AND o.channel='instagram' AND o.created_at >= $1::timestamptz
                 AND o.created_at < $2::timestamptz`,
              [start, end],
            )
          ).rows;
    const acquisitionAttributions = new Map<string, (typeof attributions)[number]>();
    for (const attribution of attributions) {
      const current = acquisitionAttributions.get(attribution.opportunity_id);
      if (
        !current ||
        new Date(attribution.received_at).getTime() < new Date(current.received_at).getTime()
      )
        acquisitionAttributions.set(attribution.opportunity_id, attribution);
    }
    const leadsByAd = new Map<string, Set<string>>();
    for (const attribution of acquisitionAttributions.values()) {
      if (!leadsByAd.has(attribution.source_id)) leadsByAd.set(attribution.source_id, new Set());
      leadsByAd.get(attribution.source_id)!.add(attribution.opportunity_id);
    }
    const campaigns = new Map<
      string,
      {
        campaign_id: string;
        campaign_name: string;
        currency: string;
        spend: number;
        impressions: number;
        reach: number;
        clicks: number;
        leads: Set<string>;
      }
    >();
    for (const row of insights) {
      const campaignId = String(row.campaign_id);
      const current = campaigns.get(campaignId) ?? {
        campaign_id: campaignId,
        campaign_name: String(row.campaign_name ?? ''),
        currency: String(row.currency ?? ''),
        spend: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        leads: new Set<string>(),
      };
      current.spend += toNumber(row.spend);
      current.impressions += toNumber(row.impressions);
      current.reach += toNumber(row.reach);
      current.clicks += toNumber(row.clicks);
      for (const lead of leadsByAd.get(String(row.ad_id)) ?? []) current.leads.add(lead);
      campaigns.set(campaignId, current);
    }
    const rows = [...campaigns.values()]
      .map((campaign) => ({
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        currency: campaign.currency,
        spend: campaign.spend,
        impressions: campaign.impressions,
        reach: campaign.reach,
        clicks: campaign.clicks,
        attributed_leads: campaign.leads.size,
        cpl: campaign.leads.size ? campaign.spend / campaign.leads.size : null,
      }))
      .sort((a, b) => b.spend - a.spend);
    const allLeads = new Set(acquisitionAttributions.keys());
    const matchedLeads = new Set(rows.flatMap((row) => [...campaigns.get(row.campaign_id)!.leads]));
    const spend = rows.reduce((total, row) => total + row.spend, 0);
    const currencies = new Set(rows.map((row) => row.currency).filter(Boolean));
    const status = await this.status();
    return {
      period: { from, to },
      currency: currencies.size === 1 ? [...currencies][0] : currencies.size ? 'MIXED' : null,
      spend,
      instagram_leads: instagramLeads.length,
      identified_paid_leads: allLeads.size,
      matched_attributed_leads: matchedLeads.size,
      unmatched_attributed_leads: Math.max(0, allLeads.size - matchedLeads.size),
      unattributed_or_organic_leads: Math.max(0, instagramLeads.length - allLeads.size),
      cpl: matchedLeads.size && currencies.size <= 1 ? spend / matchedLeads.size : null,
      campaigns: rows,
      last_sync: status.last_completed_at,
    };
  }
}

export function registerMetaMarketing(
  db: Database | MongoStore,
  config?: MetaMarketingConfig,
  runWorker = true,
  request: MetaMarketingFetch = fetch,
  clock?: () => Date,
) {
  const marketing = new MetaMarketing(db, config, request, clock);
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (!active)
      active = marketing
        .sync(7)
        .catch(() => undefined)
        .finally(() => {
          active = undefined;
        });
  };
  const startup = config && runWorker ? setTimeout(tick, 10_000) : undefined;
  const timer = config && runWorker ? setInterval(tick, 30 * 60_000) : undefined;
  startup?.unref();
  timer?.unref();
  return {
    marketing,
    async close() {
      if (startup) clearTimeout(startup);
      if (timer) clearInterval(timer);
      await active;
    },
  };
}
