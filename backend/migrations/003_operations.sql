ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE appointments ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE opportunities ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE audit_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX users_email_normalized ON users(lower(email));
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX opportunity_owner ON opportunities(owner_id,created_at DESC);
CREATE INDEX opportunity_reservation ON opportunities(reserved_to) WHERE state='RESERVED';
CREATE INDEX appointment_opportunity ON appointments(opportunity_id,starts_at);
CREATE TABLE operation_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id,key)
);
