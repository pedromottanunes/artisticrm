ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_channel_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_channel_check
  CHECK (channel IN ('manual','whatsapp','instagram','messenger'));

ALTER TABLE lead_attributions DROP CONSTRAINT IF EXISTS lead_attributions_channel_check;
ALTER TABLE lead_attributions ADD CONSTRAINT lead_attributions_channel_check
  CHECK (channel IN ('whatsapp','instagram','messenger'));

ALTER TABLE channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_provider_check;
ALTER TABLE channel_accounts ADD CONSTRAINT channel_accounts_provider_check
  CHECK (provider IN ('whatsapp','instagram','messenger'));

ALTER TABLE contact_identities DROP CONSTRAINT IF EXISTS contact_identities_provider_check;
ALTER TABLE contact_identities ADD CONSTRAINT contact_identities_provider_check
  CHECK (provider IN ('whatsapp','instagram','messenger'));

CREATE TABLE messenger_webhook_inbox (
  event_id text PRIMARY KEY,
  page_id text NOT NULL,
  event jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  last_error text,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX messenger_webhook_pending ON messenger_webhook_inbox(page_id,available_at,received_at)
  WHERE processed_at IS NULL;

CREATE INDEX messenger_profile_pending ON contact_identities(channel_account_id,profile_check_after)
  WHERE profile_pending AND provider='messenger';
