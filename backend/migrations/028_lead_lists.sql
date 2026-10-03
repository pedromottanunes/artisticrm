CREATE INDEX IF NOT EXISTS opportunities_consultation_created_at
ON opportunities(consultation_status,created_at DESC,id DESC);
