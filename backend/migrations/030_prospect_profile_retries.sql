ALTER TABLE instagram_webhook_inbox ADD COLUMN prospect_profile_attempts integer NOT NULL DEFAULT 0 CHECK (prospect_profile_attempts >= 0);
