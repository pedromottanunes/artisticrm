ALTER TABLE opportunities ADD COLUMN acquisition jsonb;
ALTER TABLE meta_marketing_daily_insights ADD COLUMN spend_micros bigint;
CREATE INDEX opportunities_acquisition_date ON opportunities ((acquisition->>'occurred_at'),id) WHERE channel='instagram';
CREATE INDEX opportunities_acquisition_ad ON opportunities ((acquisition->>'ad_id'),id) WHERE channel='instagram';

CREATE TABLE meta_marketing_ad_jobs (
  ad_id text PRIMARY KEY,
  contexts jsonb NOT NULL DEFAULT '[]',
  last_seen_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX meta_marketing_jobs_due ON meta_marketing_ad_jobs(next_attempt_at,ad_id);
CREATE TABLE meta_marketing_ads (
  account_id text NOT NULL,
  ad_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(account_id,ad_id)
);
CREATE TABLE meta_marketing_ad_versions (
  account_id text NOT NULL,
  ad_id text NOT NULL,
  content_hash text NOT NULL,
  data jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,ad_id,content_hash)
);
CREATE TABLE meta_marketing_control (
  account_id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}',
  lease_id text,
  lease_until timestamptz
);
CREATE TABLE meta_marketing_daily_coverage (
  account_id text NOT NULL,
  date_start text NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,date_start)
);
CREATE INDEX meta_marketing_insights_account_ad ON meta_marketing_daily_insights(account_id,ad_id,date_start);
CREATE INDEX lead_attributions_marketing_ids ON lead_attributions(channel,source_type,source_id);
