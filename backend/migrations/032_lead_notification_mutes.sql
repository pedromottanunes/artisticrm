CREATE TABLE lead_notification_mutes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, opportunity_id)
);
CREATE INDEX lead_notification_mutes_opportunity ON lead_notification_mutes(opportunity_id);
