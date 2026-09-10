CREATE TABLE whatsapp_inbox (
  event_id text PRIMARY KEY,
  phone_number_id text NOT NULL,
  lead jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  last_error text,
  opportunity_id uuid REFERENCES opportunities(id)
);
CREATE INDEX whatsapp_pending ON whatsapp_inbox(available_at, received_at) WHERE processed_at IS NULL;
