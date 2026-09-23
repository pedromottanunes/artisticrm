CREATE TABLE meta_marketing_accounts (
  account_id text PRIMARY KEY,
  account_name text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT '',
  timezone_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE meta_marketing_daily_insights (
  account_id text NOT NULL REFERENCES meta_marketing_accounts(account_id) ON DELETE CASCADE,
  date_start date NOT NULL,
  date_stop date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text NOT NULL DEFAULT '',
  adset_id text NOT NULL,
  adset_name text NOT NULL DEFAULT '',
  ad_id text NOT NULL,
  ad_name text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT '',
  spend numeric(18,6) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  reach bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, date_start, ad_id)
);

CREATE INDEX meta_marketing_insights_campaign_date
  ON meta_marketing_daily_insights(campaign_id, date_start);
CREATE INDEX meta_marketing_insights_ad_date
  ON meta_marketing_daily_insights(ad_id, date_start);

CREATE TABLE meta_marketing_sync_state (
  account_id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'syncing', 'error')),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error text,
  rows_synced integer NOT NULL DEFAULT 0
);
