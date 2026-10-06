import { z } from 'zod';
import { MarketingClient, MarketingError } from './meta-marketing-client.js';
import type { MarketingAd, MarketingStore } from './meta-marketing-store.js';

const objectId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const namedObject = z.object({ id: objectId, name: z.string().max(500).default('') });
const adSchema = z.object({
  id: objectId,
  account_id: objectId,
  name: z.string().max(500).default(''),
  campaign: namedObject.optional(),
  adset: namedObject.extend({ destination_type: z.string().max(100).optional() }).optional(),
  creative: z.object({ id: objectId }).optional(),
});
const creativeSchema = z.object({
  id: objectId,
  title: z.string().max(10_000).nullish(),
  body: z.string().max(10_000).nullish(),
  effective_instagram_media_id: objectId.nullish(),
  source_instagram_media_id: objectId.nullish(),
  instagram_permalink_url: z.string().max(2048).nullish(),
});

export function instagramPostUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['instagram.com', 'www.instagram.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/(p|reel|tv)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
    )
      return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export async function enrichMarketingAd(
  store: MarketingStore,
  client: MarketingClient,
  adId: string,
  lease: string,
  now: Date,
) {
  const basic = await client.get(
    encodeURIComponent(adId),
    {
      fields: 'id,account_id,name,campaign{id,name},adset{id,name,destination_type},creative{id}',
    },
    true,
  );
  const parsed = adSchema.safeParse(basic.value);
  if (
    !parsed.success ||
    parsed.data.id !== adId ||
    parsed.data.account_id !== store.accountId.replace(/^act_/, '')
  ) {
    throw new MarketingError('META_OBJECT_UNAVAILABLE');
  }
  const row = parsed.data;
  const previous = (await store.ads([adId]))[0];
  const creativeId = row.creative?.id ?? null;
  const sameCreative = previous && previous.creative_id === creativeId;
  const ad: MarketingAd = {
    ad_id: adId,
    account_id: store.accountId,
    ad_name: row.name,
    campaign_id: row.campaign?.id ?? '',
    campaign_name: row.campaign?.name ?? '',
    adset_id: row.adset?.id ?? '',
    adset_name: row.adset?.name ?? '',
    destination: row.adset?.destination_type ?? '',
    scope:
      row.adset?.destination_type === 'INSTAGRAM_DIRECT'
        ? 'instagram_direct'
        : row.adset?.destination_type
          ? 'other'
          : 'unclassified',
    creative_id: creativeId,
    checked_at: now.toISOString(),
    post_id: sameCreative ? previous.post_id : null,
    post_url: sameCreative ? previous.post_url : null,
    reference_text: sameCreative ? previous.reference_text : null,
    creative_checked_at: sameCreative ? previous.creative_checked_at : null,
  };
  // The useful ad name survives a failure in the optional publication lookup.
  await store.saveAd(ad, lease, now);
  const control = await store.control();
  if (!creativeId || Date.parse(control.creative_retry_at ?? '') > now.getTime()) return ad;
  try {
    const response = await client.get(
      encodeURIComponent(creativeId),
      {
        fields:
          'id,title,body,effective_instagram_media_id,source_instagram_media_id,instagram_permalink_url',
      },
      true,
    );
    const creative = creativeSchema.safeParse(response.value);
    if (!creative.success || creative.data.id !== creativeId)
      throw new MarketingError('INVALID_META_RESPONSE');
    const c = creative.data;
    ad.post_url = instagramPostUrl(c.instagram_permalink_url);
    ad.post_id = c.source_instagram_media_id ?? c.effective_instagram_media_id ?? null;
    ad.reference_text = (c.title || c.body || '').slice(0, 1000) || null;
    ad.creative_checked_at = now.toISOString();
    await store.saveAd(ad, lease, now);
  } catch (error) {
    if (
      error instanceof MarketingError &&
      ['META_OBJECT_UNAVAILABLE', 'META_OPTIONAL_PERMISSION'].includes(error.code)
    ) {
      await store.patch(
        { creative_retry_at: new Date(now.getTime() + 86_400_000).toISOString() },
        lease,
      );
    } else throw error;
  }
  return ad;
}
