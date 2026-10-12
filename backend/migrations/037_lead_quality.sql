ALTER TABLE opportunities ADD COLUMN non_commercial_reason text CHECK (non_commercial_reason IN ('ADVERTISING','JOB_SEEKER','NON_COMMERCIAL_MENTION','POLITICAL_VIDEO'));
ALTER TABLE opportunities ADD COLUMN non_commercial_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN non_commercial_at timestamptz;
ALTER TABLE opportunities ADD COLUMN claim_mode text;
ALTER TABLE opportunities ADD COLUMN accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN reservation_origin text;
UPDATE opportunities SET reservation_origin='rotation' WHERE reserved_to IS NOT NULL AND expires_at IS NOT NULL;
UPDATE opportunities SET claim_mode=CASE WHEN owner_id=reserved_to AND claimed_at<expires_at THEN 'reservation' ELSE 'pool' END,accepted_by=owner_id WHERE state='CLAIMED' AND owner_id IS NOT NULL AND claimed_at IS NOT NULL AND expires_at IS NOT NULL AND reserved_to IS NOT NULL;
CREATE TABLE lead_compensations (
  source_opportunity_id uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','used','revoked')),
  created_at timestamptz NOT NULL,
  used_at timestamptz,
  replacement_opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL
);
CREATE INDEX lead_compensations_pending ON lead_compensations(created_at,source_opportunity_id) WHERE status='pending';
CREATE INDEX opportunities_commercial_owner ON opportunities(owner_id,created_at DESC) WHERE non_commercial_reason IS NULL;
CREATE INDEX opportunities_non_commercial ON opportunities(created_at DESC) WHERE non_commercial_reason IS NOT NULL;
