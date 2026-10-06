CREATE INDEX IF NOT EXISTS opportunities_pool_count
  ON opportunities(state)
  WHERE state='POOL';

CREATE INDEX IF NOT EXISTS instagram_comments_available_count
  ON instagram_comments(account_id, reply_deadline_at, sender_id)
  WHERE NOT ignored AND opportunity_id IS NULL;
