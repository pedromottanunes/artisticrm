ALTER TABLE opportunities
  ADD COLUMN metrics_owner_id uuid REFERENCES users(id);

CREATE INDEX opportunity_metrics_owner
  ON opportunities(metrics_owner_id,created_at DESC);

CREATE TABLE conversation_portfolio_shares (
  id uuid PRIMARY KEY,
  source_user_id uuid NOT NULL REFERENCES users(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (source_user_id <> reviewer_user_id),
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);

CREATE UNIQUE INDEX one_active_conversation_portfolio_share
  ON conversation_portfolio_shares(source_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX active_conversation_portfolio_reviewer
  ON conversation_portfolio_shares(reviewer_user_id,source_user_id)
  WHERE revoked_at IS NULL;
