CREATE INDEX opportunities_created_at ON opportunities(created_at DESC);
CREATE INDEX opportunities_stage_created_at ON opportunities(stage, created_at DESC);
