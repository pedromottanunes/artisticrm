ALTER TABLE messages ADD COLUMN sending_started_at timestamptz;

CREATE INDEX messages_stale_sending
  ON messages(sending_started_at)
  WHERE direction='outbound' AND status='sending';

CREATE TABLE instagram_pending_referrals (
  account_id text NOT NULL,
  sender_external_id text NOT NULL,
  source_event_id text NOT NULL,
  attribution jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, sender_external_id)
);

CREATE INDEX instagram_pending_referrals_expiry
  ON instagram_pending_referrals(expires_at);
