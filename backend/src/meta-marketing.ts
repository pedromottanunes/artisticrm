import { z } from 'zod';
import type { Database } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import { DomainError } from './types.js';
import { MarketingStore } from './meta-marketing-store.js';
import {
  MarketingClient,
  MarketingError,
  configurationFingerprint,
} from './meta-marketing-client.js';
import { syncInsights } from './meta-marketing-insights.js';
import { enrichMarketingAd } from './meta-marketing-ads.js';
import {
  cachedAds,
  marketingDate,
  marketingPeriod,
  marketingReport,
  marketingLeads,
  shiftedDate,
} from './meta-marketing-reports.js';

export interface MetaMarketingConfig {
  accessToken: string;
  adAccountId: string;
  graphApiVersion: string;
  timeZone?: string;
  instagramAccountId?: string;
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
        .optional()
        .refine((value) => {
          try {
            marketingDate(new Date(0), value);
            return true;
          } catch {
            return false;
          }
        }),
      instagramAccountId: z.string().regex(/^\d+$/).optional(),
    })
    .safeParse({
      accessToken: env.META_MARKETING_ACCESS_TOKEN,
      adAccountId: env.META_AD_ACCOUNT_ID,
      graphApiVersion: env.META_GRAPH_VERSION,
      timeZone: env.META_AD_TIMEZONE || undefined,
      instagramAccountId: env.INSTAGRAM_ACCOUNT_ID || undefined,
    });
  if (!parsed.success) throw new Error('Configuração da Marketing API incompleta ou inválida.');
  return parsed.data;
}

export class MetaMarketing {
  readonly store: MarketingStore;
  private syncing?: Promise<{ rows_synced: number }>;
  constructor(
    private db: Database | MongoStore,
    private config?: MetaMarketingConfig,
    private request: MetaMarketingFetch = fetch,
    private clock: () => Date = () => new Date(),
  ) {
    this.store = new MarketingStore(db, config?.adAccountId ?? 'disabled');
  }

  private async syncState(
    state: 'syncing' | 'idle' | 'error',
    lease: string,
    values: { started?: Date; completed?: Date; error?: string | null; rows?: number } = {},
  ) {
    await this.store.transaction(async (tx) => {
      await this.store.assertLease(tx, lease, this.clock());
      if (tx instanceof MongoTx)
        await tx.collection('meta_marketing_sync_state').updateOne(
          { account_id: this.store.accountId },
          {
            $set: {
              state,
              ...(values.started ? { last_started_at: values.started } : {}),
              ...(values.completed ? { last_completed_at: values.completed } : {}),
              ...(values.error !== undefined ? { last_error: values.error } : {}),
              ...(values.rows !== undefined ? { rows_synced: values.rows } : {}),
            },
          },
          { upsert: true, session: tx.session },
        );
      else
        await tx.query(
          `INSERT INTO meta_marketing_sync_state(account_id,state,last_started_at,last_completed_at,last_error,rows_synced)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET state=EXCLUDED.state,
      last_started_at=COALESCE(EXCLUDED.last_started_at,meta_marketing_sync_state.last_started_at),
      last_completed_at=COALESCE(EXCLUDED.last_completed_at,meta_marketing_sync_state.last_completed_at),last_error=EXCLUDED.last_error,
      rows_synced=CASE WHEN $7::boolean THEN EXCLUDED.rows_synced ELSE meta_marketing_sync_state.rows_synced END`,
          [
            this.store.accountId,
            state,
            values.started ?? null,
            values.completed ?? null,
            values.error ?? null,
            values.rows ?? 0,
            values.rows !== undefined,
          ],
        );
    });
  }

  private async exclusive(
    work: (client: MarketingClient, lease: string) => Promise<{ rows_synced: number }>,
  ) {
    if (!this.config)
      throw new DomainError('META_MARKETING_DISABLED', 'Marketing API não configurada.', 503);
    const config = this.config;
    const lease = await this.store.claim(this.clock());
    if (!lease) return { rows_synced: 0 };
    try {
      const control = await this.store.control();
      if (control.blocked_config === configurationFingerprint(config))
        throw new MarketingError('META_AUTH_REQUIRED');
      if (Date.parse(control.pause_until ?? '') > this.clock().getTime())
        throw new MarketingError('META_PAUSED');
      return await work(
        new MarketingClient(this.store, config, this.request, lease, this.clock),
        lease,
      );
    } catch (error) {
      const code = error instanceof MarketingError ? error.code : 'SYNC_FAILED';
      const failures = ((await this.store.control()).failures ?? 0) + 1;
      await this.store
        .patch(
          {
            last_error: code,
            ...([
              'META_OBJECT_UNAVAILABLE',
              'META_REQUEST_REJECTED',
              'META_OPTIONAL_PERMISSION',
            ].includes(code)
              ? { pause_until: new Date(this.clock().getTime() + 86_400_000).toISOString() }
              : {}),
            ...([
              'META_NETWORK_ERROR',
              'META_TEMPORARY_ERROR',
              'SYNC_FAILED',
              'INVALID_META_RESPONSE',
              'META_SYNC_LIMIT',
              'META_PAGINATION_CYCLE',
              'META_TIMEZONE_MISMATCH',
            ].includes(code)
              ? {
                  pause_until: new Date(
                    this.clock().getTime() +
                      Math.min(3_600_000, 60_000 * 5 ** Math.min(failures - 1, 3)),
                  ).toISOString(),
                  failures,
                }
              : {}),
          },
          lease,
        )
        .catch(() => {});
      await this.syncState('error', lease, { error: code }).catch(() => {});
      throw new DomainError(
        'META_MARKETING_SYNC_FAILED',
        code === 'META_AUTH_REQUIRED'
          ? 'A conexão da Marketing API precisa de autorização. O chat continua disponível.'
          : 'A sincronização de anúncios foi adiada. Os últimos dados salvos e o chat continuam disponíveis.',
        502,
      );
    } finally {
      await this.store.release(lease);
    }
  }

  // Used by the scheduler and integration checks, never by a GET or an inbound message.
  async sync(days = 7) {
    z.number().int().min(1).max(31).parse(days);
    if (!this.syncing)
      this.syncing = this.exclusive(async (client, lease) => {
        const today = marketingDate(this.clock(), this.config?.timeZone);
        await this.syncState('syncing', lease, { started: this.clock(), error: null });
        const result = await syncInsights(
          this.store,
          client,
          lease,
          shiftedDate(today, 1 - days),
          today,
          this.clock(),
        );
        await this.syncState('idle', lease, {
          completed: this.clock(),
          rows: result.rows_synced,
          error: null,
        });
        return result;
      }).finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }

  async requestSync(input: { days?: number; from?: string; to?: string }) {
    if (!this.config)
      throw new DomainError('META_MARKETING_DISABLED', 'Marketing API não configurada.', 503);
    const now = this.clock();
    const control = await this.store.control();
    if (Date.parse(control.last_manual_at ?? '') > now.getTime() - 300_000)
      return { queued: true, already_requested: true };
    const to = input.to ?? marketingDate(now, control.timezone || this.config.timeZone);
    const from = input.from ?? shiftedDate(to, 1 - (input.days ?? 7));
    marketingPeriod(from, to, control.timezone || this.config.timeZone || 'America/Sao_Paulo', now);
    const queued = await this.store.request(
      {
        requested_at: now.toISOString(),
        requested_from: from,
        requested_to: to,
        last_manual_at: now.toISOString(),
        ...(control.blocked_config
          ? { blocked_config: '', account_checked_at: '', creative_retry_at: '' }
          : {}),
      },
      now,
    );
    return { queued: true, already_requested: !queued };
  }

  async run() {
    if (!this.config) return { rows_synced: 0 };
    if (this.syncing) return this.syncing;
    const config = this.config;
    // A paused worker checks one small document; it doesn't keep writing status/leases.
    const saved = await this.store.control();
    if (
      saved.blocked_config === configurationFingerprint(config) ||
      Date.parse(saved.pause_until ?? '') > this.clock().getTime() ||
      ((saved.budget_used ?? 0) >= 120 &&
        Date.parse(saved.budget_until ?? '') > this.clock().getTime())
    ) {
      throw new DomainError(
        'META_MARKETING_SYNC_FAILED',
        'Sincronização aguardando o prazo de retomada ou autorização. O chat continua disponível.',
        502,
      );
    }
    if (this.syncing) return this.syncing;
    this.syncing = this.exclusive(async (client, lease) => {
      let control = await this.store.control();
      const now = this.clock();
      if (
        !control.account_checked_at ||
        Date.parse(control.account_checked_at) <= now.getTime() - 86_400_000
      ) {
        const account = await client.get(config.adAccountId, {
          fields: 'id,currency,timezone_name',
        });
        const parsed = z
          .object({
            id: z.string(),
            currency: z.string().regex(/^[A-Z]{3}$/),
            timezone_name: z.string().max(100),
          })
          .safeParse(account.value);
        if (!parsed.success || parsed.data.id !== config.adAccountId)
          throw new MarketingError('INVALID_META_RESPONSE');
        try {
          marketingDate(now, parsed.data.timezone_name);
        } catch {
          throw new MarketingError('INVALID_META_RESPONSE');
        }
        if (config.timeZone && config.timeZone !== parsed.data.timezone_name)
          throw new MarketingError('META_TIMEZONE_MISMATCH');
        await this.store.patch(
          {
            currency: parsed.data.currency,
            timezone: parsed.data.timezone_name,
            account_checked_at: now.toISOString(),
            blocked_config: '',
          },
          lease,
        );
        control = await this.store.control();
      }
      await this.store.backfill(now, lease);
      for (const job of await this.store.dueAds(now, config.instagramAccountId)) {
        try {
          await enrichMarketingAd(this.store, client, job.ad_id, lease, this.clock());
          await this.store.finishAd(job.ad_id, this.clock(), null, job.attempts, lease);
        } catch (error) {
          const code = error instanceof MarketingError ? error.code : 'ENRICHMENT_FAILED';
          await this.store.finishAd(job.ad_id, this.clock(), code, job.attempts, lease);
          if (
            ![
              'META_OBJECT_UNAVAILABLE',
              'META_REQUEST_REJECTED',
              'META_OPTIONAL_PERMISSION',
            ].includes(code)
          )
            throw error;
        }
      }
      let result = { rows_synced: 0 };
      const today = marketingDate(now, control.timezone || config.timeZone);
      const weekDue =
        !control.last_week_sync || Date.parse(control.last_week_sync) <= now.getTime() - 86_400_000;
      const monthDue =
        !control.last_month_sync ||
        Date.parse(control.last_month_sync) <= now.getTime() - 7 * 86_400_000;
      if (control.requested_from || !(Date.parse(control.next_sync_at ?? '') > now.getTime())) {
        const requested = Boolean(control.requested_from);
        const from =
          control.requested_from || shiftedDate(today, monthDue ? -30 : weekDue ? -6 : -1);
        const target = control.requested_to || today;
        const to = shiftedDate(from, 6) < target ? shiftedDate(from, 6) : target;
        await this.syncState('syncing', lease, { started: now, error: null });
        result = await syncInsights(this.store, client, lease, from, to, this.clock());
        const more = to < target;
        await this.store.advance(
          {
            requested_from: more ? shiftedDate(to, 1) : '',
            requested_to: more ? target : '',
            next_sync_at: new Date(now.getTime() + (more ? 60_000 : 3_600_000)).toISOString(),
            ...(!requested && monthDue
              ? { last_month_sync: now.toISOString(), last_week_sync: now.toISOString() }
              : !requested && weekDue
                ? { last_week_sync: now.toISOString() }
                : {}),
            last_error: '',
            failures: 0,
          },
          lease,
          control.requested_at,
        );
        await this.syncState('idle', lease, {
          completed: this.clock(),
          rows: result.rows_synced,
          error: null,
        });
      }
      return result;
    }).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  async status() {
    const state =
      this.db.kind === 'mongo'
        ? await this.db.one('meta_marketing_sync_state', { account_id: this.store.accountId })
        : (
            await this.db.query('SELECT * FROM meta_marketing_sync_state WHERE account_id=$1', [
              this.store.accountId,
            ])
          ).rows[0];
    const control = await this.store.control();
    return {
      configured: Boolean(this.config),
      state: !this.config ? 'disabled' : (state?.state ?? 'idle'),
      account_id: this.config?.adAccountId,
      graph_api_version: this.config?.graphApiVersion,
      last_started_at: state?.last_started_at ?? null,
      last_completed_at: state?.last_completed_at ?? null,
      last_error: control.last_error || state?.last_error || null,
      rows_synced: state?.rows_synced ?? 0,
      queued: Boolean(control.requested_from),
      next_sync_at: control.next_sync_at ?? null,
      paused_until: control.pause_until ?? null,
      timezone: control.timezone ?? null,
    };
  }

  async report(from: string, to: string, page = 1, focusAd?: string) {
    const result = await marketingReport(
      this.store,
      this.config,
      from,
      to,
      this.clock(),
      page,
      focusAd,
    );
    result.last_sync = (await this.status()).last_completed_at as string | Date | null;
    return result;
  }

  async names(ids: string[]) {
    if (!this.config) return [];
    return cachedAds(this.store, ids);
  }

  async leads(from: string, to: string, adId: string, after?: string) {
    return marketingLeads(this.store, this.config, from, to, adId, after, this.clock());
  }

  async performance(
    acquisition?: { kind: string; ad_id: string | null; occurred_at: string } | null,
  ) {
    if (!acquisition?.ad_id || acquisition.kind !== 'paid')
      return { period: null, coverage_complete: false, performance: null };
    const control = await this.store.control();
    const tz = control.timezone || this.config?.timeZone || 'America/Sao_Paulo';
    const day = marketingDate(new Date(acquisition.occurred_at), tz);
    const from = day.slice(0, 7) + '-01';
    const [year, month] = day.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
    const today = marketingDate(this.clock(), tz);
    const to = monthEnd < today ? monthEnd : today;
    const report = await this.report(from, to, 1, acquisition.ad_id);
    return {
      period: report.period,
      coverage_complete: report.coverage_complete,
      performance: report.ads[0] ?? null,
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
        .run()
        .catch(() => undefined)
        .finally(() => {
          active = undefined;
        });
  };
  const startup = config && runWorker ? setTimeout(tick, 10_000) : undefined;
  const timer = config && runWorker ? setInterval(tick, 60_000) : undefined;
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
