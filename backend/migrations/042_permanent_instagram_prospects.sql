UPDATE instagram_prospects
SET expires_at = TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
WHERE status IN ('waiting','matched','review');
DROP INDEX instagram_prospects_pending;
CREATE INDEX instagram_prospects_pending
  ON instagram_prospects(account_id,status)
  WHERE status IN ('waiting','matched','review');
