ALTER TABLE contact_identities
  ADD COLUMN profile_picture_url text NOT NULL DEFAULT '';

ALTER TABLE contact_identities
  ADD COLUMN profile_updated_at timestamptz;
