import { createHash } from 'node:crypto';
import type { MetaMarketingConfig, MetaMarketingFetch } from './meta-marketing.js';
import type { MarketingStore } from './meta-marketing-store.js';

export class MarketingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function configurationFingerprint(config: MetaMarketingConfig) {
  return createHash('sha256')
    .update(`${config.adAccountId}:${config.graphApiVersion}:${config.accessToken}`)
    .digest('hex');
}

async function readJson(response: Response) {
  if (!response.body) throw new MarketingError('INVALID_META_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new MarketingError('META_SYNC_LIMIT');
      chunks.push(part.value);
    }
    return {
      value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      size,
    };
  } catch (error) {
    if (error instanceof MarketingError) throw error;
    throw new MarketingError('INVALID_META_RESPONSE');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class MarketingClient {
  private calls = 0;
  private bytes = 0;
  private deadline = Date.now() + 90_000;
  constructor(
    private store: MarketingStore,
    private config: MetaMarketingConfig,
    private request: MetaMarketingFetch,
    private lease: string,
    private clock: () => Date,
  ) {}

  async get(path: string, params: Record<string, string>, optional = false) {
    const now = this.clock();
    const control = await this.store.control();
    if (control.blocked_config === configurationFingerprint(this.config))
      throw new MarketingError('META_AUTH_REQUIRED');
    if (Date.parse(control.pause_until ?? '') > now.getTime())
      throw new MarketingError('META_PAUSED');
    if (++this.calls > 20 || Date.now() >= this.deadline)
      throw new MarketingError('META_CYCLE_LIMIT');
    const freshBudget = !(Date.parse(control.budget_until ?? '') > now.getTime());
    const used = freshBudget ? 0 : (control.budget_used ?? 0);
    if (used >= 120) throw new MarketingError('META_BUDGET_LIMIT');
    await this.store.transaction((tx) => this.store.assertLease(tx, this.lease, now));
    await this.store.patch(
      {
        budget_used: used + 1,
        budget_until: freshBudget
          ? new Date(now.getTime() + 3_600_000).toISOString()
          : control.budget_until,
      },
      this.lease,
    );
    let response: Response;
    try {
      response = await this.request(
        `https://graph.facebook.com/${this.config.graphApiVersion}/${path}?${new URLSearchParams(params)}`,
        {
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, this.deadline - Date.now()))),
        },
      );
    } catch {
      throw new MarketingError('META_NETWORK_ERROR');
    }
    // Only aggregate usage counters are inspected; headers/body are never logged.
    let pressure = false;
    let waitMs = 0;
    const retry = response.headers.get('retry-after');
    if (retry)
      waitMs = /^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - now.getTime());
    for (const name of ['x-app-usage', 'x-ad-account-usage', 'x-business-use-case-usage']) {
      const raw = response.headers.get(name);
      if (!raw || raw.length > 16_384) continue;
      try {
        const walk = (value: unknown, depth = 0) => {
          if (!value || typeof value !== 'object' || depth > 5) return;
          for (const [key, item] of Object.entries(value)) {
            if (
              ['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct'].includes(key) &&
              Number(item) >= 80
            )
              pressure = true;
            if (key === 'estimated_time_to_regain_access' && Number.isFinite(Number(item)))
              waitMs = Math.max(waitMs, Number(item) * 60_000);
            if (key === 'reset_time_duration' && Number.isFinite(Number(item)))
              waitMs = Math.max(waitMs, Number(item) * 1000);
            walk(item, depth + 1);
          }
        };
        walk(JSON.parse(raw));
      } catch {
        /* Optional provider header; malformed values never remove our local cap. */
      }
    }
    if (pressure || response.status === 429 || waitMs > 0)
      await this.store.patch(
        {
          pause_until: new Date(
            now.getTime() + Math.max(waitMs, pressure || response.status === 429 ? 900_000 : 0),
          ).toISOString(),
        },
        this.lease,
      );
    if ([401, 403, 429].includes(response.status) || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) throw new MarketingError('META_RATE_LIMIT');
      if (response.status >= 500) throw new MarketingError('META_TEMPORARY_ERROR');
      if (optional && response.status === 403) throw new MarketingError('META_OPTIONAL_PERMISSION');
      await this.store.patch(
        { blocked_config: configurationFingerprint(this.config), last_error: 'META_AUTH_REQUIRED' },
        this.lease,
      );
      throw new MarketingError('META_AUTH_REQUIRED');
    }
    const body = await readJson(response);
    this.bytes += body.size;
    if (this.bytes > 8 * 1024 * 1024) throw new MarketingError('META_SYNC_LIMIT');
    const providerError = body.value?.error as
      { code?: number; is_transient?: boolean } | undefined;
    if (!response.ok || providerError) {
      const code = Number(providerError?.code);
      if (optional && [10, 200, 294].includes(code))
        throw new MarketingError('META_OPTIONAL_PERMISSION');
      if (
        [102, 190, 10, 200, 294].includes(code) ||
        response.status === 401 ||
        response.status === 403
      ) {
        await this.store.patch(
          {
            blocked_config: configurationFingerprint(this.config),
            last_error: 'META_AUTH_REQUIRED',
          },
          this.lease,
        );
        throw new MarketingError('META_AUTH_REQUIRED');
      }
      if ([4, 17, 32, 613, 80000, 80001, 80002, 80004].includes(code) || response.status === 429) {
        await this.store.patch(
          { pause_until: new Date(now.getTime() + Math.max(waitMs, 900_000)).toISOString() },
          this.lease,
        );
        throw new MarketingError('META_RATE_LIMIT');
      }
      if (response.status >= 500 || providerError?.is_transient)
        throw new MarketingError('META_TEMPORARY_ERROR');
      throw new MarketingError(code === 100 ? 'META_OBJECT_UNAVAILABLE' : 'META_REQUEST_REJECTED');
    }
    return body;
  }
}
