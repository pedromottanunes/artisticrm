CREATE TABLE push_records (
  id text PRIMARY KEY,
  kind text NOT NULL,
  available_at text NOT NULL,
  expires_at text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX push_records_ready ON push_records(kind, available_at);
CREATE INDEX push_records_expiry ON push_records(expires_at);
