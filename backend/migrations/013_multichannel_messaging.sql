ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE opportunities
  ADD COLUMN channel text NOT NULL DEFAULT 'manual'
  CHECK (channel IN ('manual', 'whatsapp', 'instagram'));

ALTER TABLE lead_attributions DROP CONSTRAINT IF EXISTS lead_attributions_channel_check;
ALTER TABLE lead_attributions
  ADD CONSTRAINT lead_attributions_channel_check
  CHECK (channel IN ('whatsapp', 'instagram'));

CREATE TABLE channel_accounts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('whatsapp', 'instagram')),
  external_account_id text NOT NULL,
  username text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'token_expiring', 'disconnected', 'error')),
  graph_api_version text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, external_account_id)
);

CREATE TABLE contact_identities (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('whatsapp', 'instagram')),
  channel_account_id text NOT NULL,
  external_user_id text NOT NULL,
  username text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL,
  UNIQUE (provider, channel_account_id, external_user_id)
);

CREATE INDEX contact_identities_contact ON contact_identities(contact_id);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'blocked')),
  last_message_at timestamptz NOT NULL,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (channel_account_id, opportunity_id)
);

CREATE INDEX conversations_contact ON conversations(contact_id, last_message_at DESC);
CREATE INDEX conversations_opportunity ON conversations(opportunity_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_message_id text,
  client_request_id text,
  request_fingerprint text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_external_id text,
  sender_user_id uuid REFERENCES users(id),
  type text NOT NULL,
  text text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL
    CHECK (status IN ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown')),
  error_code text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX messages_external_id
  ON messages(external_message_id) WHERE external_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_client_request_id
  ON messages(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX messages_conversation_time ON messages(conversation_id, created_at, id);

CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  read_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE instagram_webhook_inbox (
  event_id text PRIMARY KEY,
  instagram_account_id text NOT NULL,
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

CREATE INDEX instagram_webhook_pending
  ON instagram_webhook_inbox(instagram_account_id, available_at, received_at)
  WHERE processed_at IS NULL;
