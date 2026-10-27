CREATE TABLE meta_marketing_sync_staging (
  account_id text NOT NULL,
  run_id text NOT NULL,
  kind text NOT NULL,
  record_key text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (account_id,run_id,kind,record_key)
);
