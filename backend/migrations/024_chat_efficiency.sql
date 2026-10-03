ALTER TABLE contact_identities ADD COLUMN profile_pending boolean NOT NULL DEFAULT false;
ALTER TABLE contact_identities ADD COLUMN profile_opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE contact_identities ADD COLUMN profile_check_after timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';
CREATE INDEX instagram_profile_pending ON contact_identities(channel_account_id,profile_check_after) WHERE profile_pending AND provider='instagram';
CREATE INDEX instagram_comment_media_cache ON instagram_comments(account_id,media_id,preview_checked_at DESC);
CREATE INDEX conversations_channel_recent ON conversations(channel_account_id,last_message_at DESC,id);
ALTER TABLE instagram_comments ADD COLUMN timestamp_verified_at timestamptz;
