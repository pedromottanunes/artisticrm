CREATE TABLE lead_attributions (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  external_id text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider = 'meta'),
  channel text NOT NULL CHECK (channel = 'whatsapp'),
  source_type text NOT NULL CHECK (source_type = 'ad'),
  source_id text,
  source_url text,
  ctwa_clid text,
  headline text,
  body text,
  media_type text,
  image_url text,
  video_url text,
  thumbnail_url text,
  received_at timestamptz NOT NULL
);

CREATE INDEX lead_attributions_opportunity
  ON lead_attributions(opportunity_id, received_at DESC);
