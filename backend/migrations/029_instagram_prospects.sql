CREATE TABLE instagram_prospects (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  username text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting','matched','review','cancelled')),
  external_user_id text,
  opportunity_id uuid,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(account_id,username)
);
CREATE INDEX instagram_prospects_owner ON instagram_prospects(account_id,owner_id,updated_at DESC,id DESC);
CREATE INDEX instagram_prospects_list ON instagram_prospects(account_id,updated_at DESC,id DESC);
CREATE INDEX instagram_prospects_pending ON instagram_prospects(account_id,status,expires_at);
CREATE INDEX instagram_prospects_identity ON instagram_prospects(account_id,external_user_id);
CREATE INDEX instagram_prospects_lead ON instagram_prospects(opportunity_id);
CREATE INDEX instagram_identity_username ON contact_identities(channel_account_id,lower(username)) WHERE provider='instagram';
ALTER TABLE instagram_webhook_inbox ADD COLUMN prospect_routing jsonb;
