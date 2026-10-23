-- Independent commercial facts. Legacy opportunity fields remain declarations.
CREATE TABLE commercial_records (
  id text PRIMARY KEY,
  opportunity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('case','evidence','job','payment','contract','audit','command','extraction')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX commercial_records_case ON commercial_records(opportunity_id,kind,created_at);
CREATE INDEX commercial_jobs_ready ON commercial_records((data->>'status'),(data->>'available_at')) WHERE kind='job';
CREATE UNIQUE INDEX commercial_confirmed_transaction ON commercial_records((data->>'transaction_key'))
  WHERE kind='payment' AND data->>'status'='confirmed' AND data->>'transaction_key' IS NOT NULL;
CREATE TABLE commercial_files (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL,
  content bytea NOT NULL,
  CHECK (octet_length(content) <= 8388608)
);
CREATE INDEX commercial_files_case ON commercial_files(opportunity_id);
CREATE TABLE commercial_budgets (
  id text PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0)
);
CREATE TABLE commercial_payment_claims (
  id text PRIMARY KEY,
  payment_id text NOT NULL,
  opportunity_id uuid NOT NULL
);
CREATE INDEX commercial_payment_claims_case ON commercial_payment_claims(opportunity_id);
